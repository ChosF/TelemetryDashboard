# mock_generator.py
"""
Standalone mock data generation module for TelemetryDashboard.
Extracted from maindata.py to serve as training/validation data for outlier detection.
"""

import logging
import math
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger("TelemetryBridge.MockGenerator")


# ------------------------------
# Mock Mode Configuration
# ------------------------------

class MockScenario(Enum):
    """Available mock simulation scenarios"""
    NORMAL = "normal"
    SENSOR_FAILURES = "sensor_failures"
    DATA_STALLS = "data_stalls"
    INTERMITTENT = "intermittent"
    GPS_ISSUES = "gps_issues"
    CHAOS = "chaos"


@dataclass
class MockModeConfig:
    """Configuration for mock data simulation with error scenarios"""
    scenario: MockScenario = MockScenario.NORMAL
    
    # Sensor failure settings
    sensor_failure_probability: float = 0.0  # 0-1, chance per message
    failed_sensors: List[str] = field(default_factory=list)
    sensor_failure_duration: int = 0  # messages to fail for
    
    # Data stall settings
    stall_probability: float = 0.0  # chance to start a stall
    stall_duration_min: float = 3.0  # seconds
    stall_duration_max: float = 15.0  # seconds
    stall_active: bool = False
    stall_end_time: float = 0.0
    
    # Intermittent connection settings
    drop_probability: float = 0.0  # chance to drop a message
    burst_drop_probability: float = 0.0  # chance to drop multiple messages
    burst_drop_count: int = 0  # remaining messages to drop in burst
    
    # GPS issues settings
    gps_drift_active: bool = False
    gps_accuracy_degraded: bool = False
    gps_jump_probability: float = 0.0  # chance of sudden position jump
    
    @classmethod
    def from_scenario(cls, scenario: MockScenario) -> "MockModeConfig":
        """Create configuration for a specific scenario"""
        config = cls(scenario=scenario)
        
        if scenario == MockScenario.NORMAL:
            pass  # All defaults (no errors)
            
        elif scenario == MockScenario.SENSOR_FAILURES:
            config.sensor_failure_probability = 0.08
            config.sensor_failure_duration = 25
            
        elif scenario == MockScenario.DATA_STALLS:
            config.stall_probability = 0.02
            config.stall_duration_min = 5.0
            config.stall_duration_max = 20.0
            
        elif scenario == MockScenario.INTERMITTENT:
            config.drop_probability = 0.05
            config.burst_drop_probability = 0.02
            
        elif scenario == MockScenario.GPS_ISSUES:
            config.gps_drift_active = True
            config.gps_accuracy_degraded = True
            config.gps_jump_probability = 0.01
            
        elif scenario == MockScenario.CHAOS:
            # Everything enabled at moderate levels
            config.sensor_failure_probability = 0.04
            config.sensor_failure_duration = 15
            config.stall_probability = 0.01
            config.stall_duration_min = 3.0
            config.stall_duration_max = 10.0
            config.drop_probability = 0.03
            config.burst_drop_probability = 0.01
            config.gps_drift_active = True
            config.gps_jump_probability = 0.005
            
        return config


# ------------------------------
# Mock Data Generator
# ------------------------------

class MockDataGenerator:
    """
    Generates mock telemetry data with configurable error scenarios.
    Use for training/validation of outlier detection algorithms.
    """
    
    # Default data interval in seconds
    DEFAULT_DATA_INTERVAL = 0.2
    
    def __init__(
        self, 
        config: Optional[MockModeConfig] = None,
        session_id: Optional[str] = None,
        session_name: Optional[str] = None,
        data_interval: float = DEFAULT_DATA_INTERVAL
    ):
        self.config = config or MockModeConfig()
        self.session_id = session_id or "mock-session"
        self.session_name = session_name or "Mock Session"
        self.data_interval = data_interval
        
        # Simulation state
        self.cumulative_distance = 0.0
        self.cumulative_energy = 0.0
        self.simulation_time = 0
        self.prev_speed = 0.0
        self.message_count = 0
        self.base_altitude = 100.0
        self.base_lat = 40.7128
        self.base_lon = -74.0060
        
        # Error simulation state
        self._sensor_failure_remaining = 0
        self._current_failed_sensors: List[str] = []
        self._gps_drift_offset = (0.0, 0.0)
        
        # Stats
        self.stats = {
            "messages_generated": 0,
            "messages_dropped": 0,
            "sensor_failures": 0,
            "gps_jumps": 0,
            "stalls": 0,
        }
    
    def reset(self) -> None:
        """Reset generator state for a new session"""
        self.cumulative_distance = 0.0
        self.cumulative_energy = 0.0
        self.simulation_time = 0
        self.prev_speed = 0.0
        self.message_count = 0
        self._sensor_failure_remaining = 0
        self._current_failed_sensors = []
        self._gps_drift_offset = (0.0, 0.0)
        self.stats = {k: 0 for k in self.stats}
    
    def _apply_sensor_failures(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Apply sensor failure simulation"""
        cfg = self.config
        
        # Check if we should start new sensor failures
        if self._sensor_failure_remaining <= 0:
            if random.random() < cfg.sensor_failure_probability:
                # Start a new failure period
                self._sensor_failure_remaining = cfg.sensor_failure_duration
                # Pick random sensors to fail
                all_sensors = [
                    "voltage_v", "current_a", "gyro_x", "gyro_y", "gyro_z",
                    "accel_x", "accel_y", "accel_z"
                ]
                fail_count = random.randint(1, 4)
                self._current_failed_sensors = random.sample(all_sensors, fail_count)
                self.stats["sensor_failures"] += 1
                logger.warning(f"⚠️ SIMULATION: Sensor failure started for {self._current_failed_sensors}")
        
        # Apply failures if active
        if self._sensor_failure_remaining > 0:
            for sensor in self._current_failed_sensors:
                if sensor in data:
                    # Make sensor report static or corrupted value
                    if random.random() < 0.7:
                        data[sensor] = 0.0  # Static zero
                    else:
                        data[sensor] = random.uniform(-999, 999)  # Corrupted
            self._sensor_failure_remaining -= 1
            if self._sensor_failure_remaining == 0:
                logger.info("✅ SIMULATION: Sensor failure recovered")
        
        return data
    
    def _apply_gps_issues(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Apply GPS simulation issues"""
        cfg = self.config
        
        if not cfg.gps_drift_active and not cfg.gps_accuracy_degraded:
            return data
        
        # GPS drift - slowly accumulating error
        if cfg.gps_drift_active:
            self._gps_drift_offset = (
                self._gps_drift_offset[0] + random.gauss(0, 0.00002),
                self._gps_drift_offset[1] + random.gauss(0, 0.00002)
            )
            # Occasional correction (GPS recalibration)
            if random.random() < 0.005:
                self._gps_drift_offset = (
                    self._gps_drift_offset[0] * 0.5,
                    self._gps_drift_offset[1] * 0.5
                )
            data["latitude"] = data.get("latitude", 0) + self._gps_drift_offset[0]
            data["longitude"] = data.get("longitude", 0) + self._gps_drift_offset[1]
        
        # GPS accuracy degradation - larger noise
        if cfg.gps_accuracy_degraded:
            data["latitude"] = data.get("latitude", 0) + random.gauss(0, 0.0005)
            data["longitude"] = data.get("longitude", 0) + random.gauss(0, 0.0005)
            data["altitude"] = data.get("altitude", 0) + random.gauss(0, 5)
        
        # Sudden position jump
        if random.random() < cfg.gps_jump_probability:
            jump_lat = random.uniform(-0.01, 0.01)
            jump_lon = random.uniform(-0.01, 0.01)
            data["latitude"] = data.get("latitude", 0) + jump_lat
            data["longitude"] = data.get("longitude", 0) + jump_lon
            self.stats["gps_jumps"] += 1
            logger.warning(f"⚠️ SIMULATION: GPS position jump ({jump_lat:.4f}, {jump_lon:.4f})")
        
        return data
    
    def _should_stall(self) -> bool:
        """Check if we should stall data generation"""
        cfg = self.config
        now = time.monotonic()
        
        # Check if stall is currently active
        if cfg.stall_active:
            if now < cfg.stall_end_time:
                return True
            else:
                cfg.stall_active = False
                logger.info("✅ SIMULATION: Data stall ended, resuming...")
                return False
        
        # Check if we should start a new stall
        if random.random() < cfg.stall_probability:
            duration = random.uniform(cfg.stall_duration_min, cfg.stall_duration_max)
            cfg.stall_active = True
            cfg.stall_end_time = now + duration
            self.stats["stalls"] += 1
            logger.warning(f"⚠️ SIMULATION: Data stall started ({duration:.1f}s)")
            return True
        
        return False
    
    def _should_drop_message(self) -> bool:
        """Check if we should drop this message (intermittent simulation)"""
        cfg = self.config
        
        # Check burst drop
        if cfg.burst_drop_count > 0:
            cfg.burst_drop_count -= 1
            return True
        
        # Check for new burst
        if random.random() < cfg.burst_drop_probability:
            cfg.burst_drop_count = random.randint(3, 10)
            logger.warning(f"⚠️ SIMULATION: Burst drop started ({cfg.burst_drop_count} messages)")
            return True
        
        # Normal drop
        if random.random() < cfg.drop_probability:
            return True
        
        return False
    
    def generate(self) -> Optional[Dict[str, Any]]:
        """
        Generate a single mock telemetry data point.
        Returns None if data should be stalled or dropped.
        """
        # Check for data stall
        if self._should_stall():
            return None
        
        # Check for message drop
        if self._should_drop_message():
            self.stats["messages_dropped"] += 1
            return None
        
        now = datetime.now(timezone.utc)
        
        # Speed simulation (sinusoidal with noise)
        base_speed = 15.0 + 5.0 * math.sin(self.simulation_time * 0.1)
        speed_variation = random.gauss(0, 1.4)
        speed = max(0, min(25, base_speed + speed_variation))
        
        # Electrical values
        voltage = max(40, min(55, 48.0 + random.gauss(0, 1.4)))
        current = max(0, min(15, 7.5 + speed * 0.2 + random.gauss(0, 0.9)))
        power = voltage * current
        
        # Cumulative values
        energy_delta = power * self.data_interval
        distance_delta = speed * self.data_interval
        self.cumulative_energy += energy_delta
        self.cumulative_distance += distance_delta
        
        # GPS simulation (circular path)
        lat_offset = 0.001 * math.sin(self.simulation_time * 0.05)
        lon_offset = 0.001 * math.cos(self.simulation_time * 0.05)
        latitude = self.base_lat + lat_offset + random.gauss(0, 0.0001)
        longitude = self.base_lon + lon_offset + random.gauss(0, 0.0001)
        
        # Altitude variation
        altitude_variation = 10.0 * math.sin(self.simulation_time * 0.03)
        altitude = self.base_altitude + altitude_variation + random.gauss(0, 1.0)
        
        # IMU simulation
        turning_rate = 2.0 * math.sin(self.simulation_time * 0.08)
        gyro_x = random.gauss(0, 0.5)
        gyro_y = random.gauss(0, 0.3)
        gyro_z = turning_rate + random.gauss(0, 0.8)
        
        speed_acc = (speed - self.prev_speed) / self.data_interval
        self.prev_speed = speed
        accel_x = speed_acc + random.gauss(0, 0.2)
        accel_y = turning_rate * speed * 0.1 + random.gauss(0, 0.1)
        accel_z = 9.81 + random.gauss(0, 0.05)
        vib = speed * 0.02
        accel_x += random.gauss(0, vib)
        accel_y += random.gauss(0, vib)
        accel_z += random.gauss(0, vib)
        total_acc = math.sqrt(accel_x**2 + accel_y**2 + accel_z**2)
        
        # Driver inputs (mock)
        phase = (math.sin(self.simulation_time * 0.06) + 1) / 2  # 0..1
        th_base = 20 + 70 * phase  # 20..90%
        brake_event = (self.simulation_time % 120) in range(0, 12) or random.random() < 0.03
        if brake_event:
            brake_pct = min(100.0, max(15.0, 60 + random.gauss(0, 15)))
            throttle_pct = max(0.0, th_base - brake_pct * 0.6)
        else:
            brake_pct = max(0.0, random.gauss(2, 1))
            throttle_pct = min(100.0, max(5.0, th_base + random.gauss(0, 5)))
        
        self.simulation_time += 1
        self.message_count += 1
        self.stats["messages_generated"] += 1
        
        data = {
            "timestamp": now.isoformat(),
            "speed_ms": round(speed, 2),
            "voltage_v": round(voltage, 2),
            "current_a": round(current, 2),
            "power_w": round(power, 2),
            "energy_j": round(self.cumulative_energy, 2),
            "distance_m": round(self.cumulative_distance, 2),
            "latitude": round(latitude, 6),
            "longitude": round(longitude, 6),
            "altitude": round(altitude, 2),
            "gyro_x": round(gyro_x, 3),
            "gyro_y": round(gyro_y, 3),
            "gyro_z": round(gyro_z, 3),
            "accel_x": round(accel_x, 3),
            "accel_y": round(accel_y, 3),
            "accel_z": round(accel_z, 3),
            "total_acceleration": round(total_acc, 3),
            "message_id": self.message_count,
            "uptime_seconds": self.simulation_time * self.data_interval,
            "data_source": f"MOCK_{self.config.scenario.value.upper()}",
            "session_id": self.session_id,
            "session_name": self.session_name,
            "throttle_pct": round(throttle_pct, 1),
            "brake_pct": round(brake_pct, 1),
            "throttle": round(throttle_pct / 100.0, 3),
            "brake": round(brake_pct / 100.0, 3),
        }
        
        # Apply error simulations
        if self.config.scenario in (MockScenario.SENSOR_FAILURES, MockScenario.CHAOS):
            data = self._apply_sensor_failures(data)
        
        if self.config.scenario in (MockScenario.GPS_ISSUES, MockScenario.CHAOS):
            data = self._apply_gps_issues(data)
        
        return data
    
    def generate_batch(self, count: int, include_stalls: bool = False) -> List[Dict[str, Any]]:
        """
        Generate multiple data points for batch testing.
        If include_stalls is False, None values are skipped.
        """
        results = []
        for _ in range(count):
            data = self.generate()
            if data is not None or include_stalls:
                results.append(data)
        return results


# ------------------------------
# Utility functions for standalone testing
# ------------------------------

def run_generator_test(scenario: MockScenario = MockScenario.CHAOS, count: int = 100):
    """Run a quick test of the generator with statistics output"""
    config = MockModeConfig.from_scenario(scenario)
    generator = MockDataGenerator(config=config)
    
    print(f"Running {scenario.value.upper()} scenario for {count} iterations...")
    
    data_points = generator.generate_batch(count)
    
    print(f"\nResults:")
    print(f"  Generated: {generator.stats['messages_generated']}")
    print(f"  Dropped: {generator.stats['messages_dropped']}")
    print(f"  Sensor failures: {generator.stats['sensor_failures']}")
    print(f"  GPS jumps: {generator.stats['gps_jumps']}")
    print(f"  Stalls: {generator.stats['stalls']}")
    print(f"  Actual data points: {len(data_points)}")
    
    return data_points


if __name__ == "__main__":
    # Self-test when run directly
    run_generator_test(MockScenario.CHAOS, 500)
