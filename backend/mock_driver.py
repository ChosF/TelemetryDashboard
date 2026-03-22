"""
mock_driver.py — Standalone mock telemetry publisher for the Driver Dashboard

Sends realistic EV race-lap telemetry directly to the Ably dashboard channel
(telemetry-dashboard-channel) at ~5 Hz, so you can test the driver dashboard
UI without running the full bridge or needing an ESP32.

Usage:
    python backend/mock_driver.py

Requirements:
    pip install ably
"""

import asyncio
import json
import math
import random
import sys
import time
import uuid
from datetime import datetime, timezone

# Force UTF-8 output on Windows (avoids cp1252 UnicodeEncodeError)
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from ably import AblyRealtime
except ImportError:
    print("[ERR] Ably not installed. Run:  pip install ably")
    sys.exit(1)

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG  (same credentials as maindata.py)
# ──────────────────────────────────────────────────────────────────────────────

ABLY_API_KEY    = "DxuYSw.fQHpug:sa4tOcqWDkYBW9ht56s7fT0G091R1fyXQc6mc8WthxQ"
CHANNEL_NAME    = "telemetry-dashboard-channel"
PUBLISH_HZ      = 5          # messages per second
INTERVAL        = 1 / PUBLISH_HZ
SESSION_ID      = str(uuid.uuid4())
SESSION_NAME    = f"MockDriver_{SESSION_ID[:6]}"

# Simulated GPS track centre (adjust to your testing area if you like)
BASE_LAT        = 19.4326     # Mexico City approx
BASE_LON        = -99.1332
TRACK_RADIUS_M  = 200         # circular track radius in metres

# ──────────────────────────────────────────────────────────────────────────────
# SIMULATION STATE
# ──────────────────────────────────────────────────────────────────────────────

class SimState:
    def __init__(self):
        self.t          = 0.0          # elapsed real time (s)
        self.lap_angle  = 0.0          # position on circular track (radians)
        self.speed_ms   = 0.0          # current speed m/s
        self.voltage_v  = 84.0         # battery voltage
        self.message_id = 0

        # Scenario cycling
        self.scenario_t = 0.0
        self.current_scenario = "normal"

        # Cumulative energy for efficiency calculation
        self.cumulative_energy_j = 0.0
        self.cumulative_dist_m   = 0.0

        # Smoothed throttle/brake
        self._throttle = 0.0
        self._brake    = 0.0

        # Optimal speed accumulator data
        self._speed_power_history: list = []   # [(speed_ms, power_w)]
        self._optimal_speed_kmh: float | None = None
        self._optimal_confidence: float = 0.0
        self._opt_update_counter = 0

    # ── Scenario logic ────────────────────────────────────────────────────────

    def _get_scenario(self) -> str:
        """Cycle through scenarios every ~20 s to exercise the notification engine"""
        t = self.t % 120
        if t < 30:   return "normal"
        if t < 50:   return "eco"
        if t < 70:   return "aggressive"
        if t < 90:   return "braking"
        return "normal"

    # ── Physics helpers ───────────────────────────────────────────────────────

    def _target_speed_ms(self) -> float:
        scenario = self._get_scenario()
        if scenario == "eco":        return 6.0  + random.gauss(0, 0.3)
        if scenario == "aggressive": return 14.0 + random.gauss(0, 0.5)
        if scenario == "braking":    return 2.0  + random.gauss(0, 0.2)
        # normal: sinusoidal lap variation between 6 and 12 m/s
        base = 9.0 + 3.0 * math.sin(self.lap_angle * 2)
        return max(1.0, base + random.gauss(0, 0.3))

    def _update_speed(self, target: float) -> None:
        """First-order lag (τ = 1 s) towards target speed"""
        alpha = 1.0 - math.exp(-INTERVAL / 1.0)
        self.speed_ms = self.speed_ms + alpha * (target - self.speed_ms)
        self.speed_ms = max(0.0, self.speed_ms)

    def _compute_pedals(self, target: float):
        delta = target - self.speed_ms
        if delta > 0.5:
            t = min(1.0, delta / 5.0)
            b = 0.0
        elif delta < -0.5:
            t = 0.0
            b = min(1.0, abs(delta) / 5.0)
        else:
            t, b = 0.02, 0.0   # tiny creep throttle

        # Smooth with 0.2 s lag
        a = 1.0 - math.exp(-INTERVAL / 0.2)
        self._throttle = self._throttle + a * (t - self._throttle)
        self._brake    = self._brake    + a * (b - self._brake)

    def _power_from_speed(self, speed_ms: float) -> float:
        """Simple EV power model: rolling + aero drag"""
        v       = max(0.0, speed_ms)
        rolling = 50 * v          # W  (Crr * mass * g * v)
        aero    = 0.35 * v ** 3   # W  (0.5 * Cd * A * rho * v³)
        regen   = -20 * self._brake  # slight regen on brake
        noise   = random.gauss(0, 5)
        return max(0.0, rolling + aero + regen + noise)

    def _update_optimal_speed(self, speed_ms: float, power_w: float) -> None:
        """Lightweight polynomial regression to estimate optimal speed"""
        self._speed_power_history.append((speed_ms, power_w))
        if len(self._speed_power_history) > 500:
            self._speed_power_history = self._speed_power_history[-500:]

        self._opt_update_counter += 1
        if self._opt_update_counter < 10:
            return
        self._opt_update_counter = 0

        n = len(self._speed_power_history)
        if n < 30:
            return

        try:
            import numpy as np
            speeds = [p[0] for p in self._speed_power_history]
            powers = [p[1] for p in self._speed_power_history]
            s = np.array(speeds)
            p = np.array(powers)
            coeffs = np.polyfit(s, p, 3)
            poly   = np.poly1d(coeffs)

            sr = np.arange(max(1.0, s.min()), min(20.0, s.max()), 0.2)
            if len(sr) < 5:
                return
            pred = poly(sr)
            eff  = sr / np.maximum(pred, 1e-6)   # m/s per W → max is optimal
            idx  = int(np.argmax(eff))
            opt_ms = float(sr[idx])

            # Confidence: data quantity × fit quality
            res      = p - poly(s)
            ss_res   = float(np.sum(res ** 2))
            ss_tot   = float(np.sum((p - p.mean()) ** 2))
            r2       = 1 - ss_res / (ss_tot + 1e-9)
            data_c   = min(1.0, n / 100)
            fit_c    = max(0.0, r2) if r2 > 0.5 else 0.0
            self._optimal_confidence = round(data_c * 0.5 + fit_c * 0.5, 2)
            self._optimal_speed_kmh  = round(opt_ms * 3.6, 1) if self._optimal_confidence >= 0.3 else None
        except Exception:
            pass

    # ── GPS helpers ───────────────────────────────────────────────────────────

    def _gps(self):
        """Simple circular track"""
        EARTH_R = 6_371_000
        dLat = (TRACK_RADIUS_M * math.sin(self.lap_angle)) / EARTH_R
        dLon = (TRACK_RADIUS_M * math.cos(self.lap_angle)) / (EARTH_R * math.cos(math.radians(BASE_LAT)))
        return (
            BASE_LAT + math.degrees(dLat),
            BASE_LON + math.degrees(dLon),
            1200 + 5.0 * math.sin(self.lap_angle * 3),  # altitude
        )

    # ── Main tick ─────────────────────────────────────────────────────────────

    def tick(self) -> dict:
        self.t          += INTERVAL
        self.message_id += 1

        target = self._target_speed_ms()
        self._update_speed(target)
        self._compute_pedals(target)

        v = self.speed_ms
        power_w = self._power_from_speed(v)

        # Update cumulative energy & distance
        self.cumulative_energy_j += power_w * INTERVAL
        self.cumulative_dist_m   += v * INTERVAL

        # Advance lap angle
        if v > 0.1:
            self.lap_angle += (v * INTERVAL) / TRACK_RADIUS_M

        # Optimal speed
        self._update_optimal_speed(v, power_w)

        # Voltage sags slightly with current
        current_a = power_w / max(self.voltage_v, 1.0)
        self.voltage_v = max(60.0, 84.0 - current_a * 0.05 + random.gauss(0, 0.1))
        brake2_pct = round(min(100.0, max(0.0, self._brake * 100.0 * 0.72 + random.gauss(0, 2.0))), 1)
        motor_voltage_v = round(max(0.0, self.voltage_v * 0.94 + random.gauss(0, 0.15)), 2)
        motor_current_a = round(max(-40.0, current_a * 1.08 + random.gauss(0, 0.35)), 2)
        motor_rpm = round(max(0.0, v * 315.0 + random.gauss(0, 18.0)), 1)
        motor_phase_current_a = round(max(-50.0, motor_current_a * 1.14 + random.gauss(0, 0.45)), 2)

        # Efficiency km/kWh
        energy_kwh = self.cumulative_energy_j / 3_600_000
        dist_km    = self.cumulative_dist_m / 1000
        eff = round(dist_km / energy_kwh, 2) if energy_kwh > 0.001 else None

        # GForce approximate
        ax = (v - self.speed_ms) / INTERVAL if self.t > INTERVAL else 0.0
        lat, lon, alt = self._gps()

        # Driver mode
        if self._throttle > 0.7:   driver_mode = "aggressive"
        elif self._brake > 0.1:   driver_mode = "braking"
        elif self._throttle < 0.1: driver_mode = "coasting"
        else:                       driver_mode = "eco"

        motion_state = "stationary" if v < 0.3 else ("decelerating" if self._brake > 0.05 else "moving")

        scenario = self._get_scenario()

        payload = {
            # Identification
            "session_id":   SESSION_ID,
            "session_name": SESSION_NAME,
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "message_id":   self.message_id,
            "uptime_seconds": round(self.t, 2),
            "data_source":  "MOCK_DRIVER",

            # Speed
            "speed_ms":  round(v, 3),

            # Electrical
            "voltage_v": round(self.voltage_v, 2),
            "current_a": round(current_a, 2),
            "power_w":   round(power_w, 2),
            "energy_j":  round(self.cumulative_energy_j, 2),

            # Distance
            "distance_m": round(self.cumulative_dist_m, 2),

            # GPS
            "latitude":  round(lat, 6),
            "longitude": round(lon, 6),
            "altitude":  round(alt, 2),

            # IMU (simple approximation)
            "accel_x": round(ax / 9.80665, 3),
            "accel_y": round(random.gauss(0, 0.02), 3),
            "accel_z": round(-1.0 + random.gauss(0, 0.01), 3),
            "gyro_x":  round(random.gauss(0, 0.1), 3),
            "gyro_y":  round(random.gauss(0, 0.1), 3),
            "gyro_z":  round(random.gauss(0, 0.1), 3),
            "total_acceleration": round(abs(ax / 9.80665), 3),

            # Driver inputs
            "throttle":     round(self._throttle, 3),
            "brake":        round(self._brake, 3),
            "throttle_pct": round(self._throttle * 100, 1),
            "brake_pct":    round(self._brake * 100, 1),
            "brake2_pct":   brake2_pct,
            "brake2":       round(brake2_pct / 100.0, 3),

            # Motor CAN bus
            "motor_voltage_v":       motor_voltage_v,
            "motor_current_a":       motor_current_a,
            "motor_rpm":             motor_rpm,
            "motor_phase_current_a": motor_phase_current_a,

            # Driver state
            "driver_mode":  driver_mode,
            "motion_state": motion_state,

            # Efficiency
            "current_efficiency_km_kwh": eff,
            "cumulative_energy_kwh": round(energy_kwh, 6),
            "route_distance_km":     round(dist_km, 3),

            # Optimal speed
            "optimal_speed_kmh":          self._optimal_speed_kmh,
            "optimal_speed_confidence":   self._optimal_confidence,
            "optimal_speed_data_points":  len(self._speed_power_history),

            # Mock metadata
            "_mock_scenario": scenario,
        }

        return payload


# ──────────────────────────────────────────────────────────────────────────────
# MAIN PUBLISHER LOOP
# ──────────────────────────────────────────────────────────────────────────────

async def run():
    print("=" * 55)
    print("  EcoVolt Driver Dashboard — Mock Publisher")
    print("=" * 55)
    print(f"  Channel : {CHANNEL_NAME}")
    print(f"  Rate    : {PUBLISH_HZ} Hz  ({INTERVAL*1000:.0f} ms/msg)")
    print(f"  Session : {SESSION_NAME}")
    print("  Press Ctrl+C to stop.\n")

    client  = AblyRealtime(ABLY_API_KEY)
    channel = client.channels.get(CHANNEL_NAME)

    # Wait for connection
    print("[..] Connecting to Ably...", end="", flush=True)
    deadline = time.time() + 10
    while time.time() < deadline:
        if client.connection.state == "connected":
            break
        await asyncio.sleep(0.1)
    if client.connection.state != "connected":
        print(f"\n[ERR] Could not connect (state: {client.connection.state})")
        await client.close()
        return
    print(" [OK]  Connected\n")

    sim     = SimState()
    sent    = 0
    t_start = time.time()

    try:
        while True:
            loop_start = time.time()

            payload = sim.tick()
            await channel.publish("telemetry_update", json.dumps(payload))
            sent += 1

            elapsed = time.time() - t_start
            speed_kmh = payload["speed_ms"] * 3.6
            scenario  = payload.get("_mock_scenario", "-")
            eff       = payload.get("current_efficiency_km_kwh")
            opt_kmh   = payload.get("optimal_speed_kmh")
            opt_conf  = payload.get("optimal_speed_confidence", 0)

            print(
                f"\r  [{elapsed:6.1f}s]  "
                f"Speed: {speed_kmh:5.1f} kph  "
                f"T:{payload['throttle_pct']:4.0f}%  B:{payload['brake_pct']:4.0f}%  "
                f"Eff: {f'{eff:.1f}' if eff else '-':>5} km/kWh  "
                f"Opt: {f'{opt_kmh:.0f}' if opt_kmh else '—':>3} kph ({opt_conf:.2f})  "
                f"[{scenario}]  msg#{sent}   ",
                end="",
                flush=True,
            )

            # Sleep for the remainder of the interval (constant-rate publishing)
            sleep_for = INTERVAL - (time.time() - loop_start)
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

    except KeyboardInterrupt:
        print(f"\n\n[STOP] Stopped after {sent} messages ({time.time()-t_start:.1f} s).")
    finally:
        await client.close()
        print("[--] Ably connection closed.")


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
