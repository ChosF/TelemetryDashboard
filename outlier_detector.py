# outlier_detector.py
"""
NumPy-based outlier detection engine for telemetry data.
Target latency: <5ms per message.

Detection algorithms for:
- Electrical (voltage, current, power)
- IMU (gyro, accel)
- GPS (position, altitude, speed consistency)
- Speed (limits, acceleration)
- Cumulative values (monotonic checks)
"""

import logging
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

logger = logging.getLogger("TelemetryBridge.OutlierDetector")


# ------------------------------
# Configuration
# ------------------------------

@dataclass
class OutlierConfig:
    """Configuration for outlier detection thresholds
    
    TUNED thresholds based on mock data analysis:
    - GPS checks are lenient (mock GPS doesn't correlate with speed)
    - Electrical bounds match mock data range (40-55V, 0-15A)
    - Jump/change detection is relaxed for normal noise
    """
    
    # Rolling window size
    window_size: int = 50
    
    # Z-score threshold for statistical outliers (higher = less sensitive)
    z_score_threshold: float = 5.0  # Was 4.0, increased for less sensitivity
    
    # Electrical bounds (matched to mock data generation)
    voltage_min: float = 35.0   # Mock: 40-55V, allow small margin
    voltage_max: float = 60.0
    current_min: float = -10.0  # Allow some regen/negative
    current_max: float = 35.0   # Mock: 0-15A, real may be higher
    power_min: float = -500.0   # Allow regen
    power_max: float = 2500.0
    
    # Electrical jump detection - only flag extreme jumps (% of rolling mean)
    electrical_jump_pct: float = 0.50  # Was 0.20, now 50% jump needed
    
    # Stuck sensor detection - need more consecutive identical values
    stuck_sensor_count: int = 15  # Was 10, now 15 for fewer false positives
    
    # IMU bounds - very lenient for normal operation
    accel_magnitude_max: float = 80.0  # Was 50, allow higher bounds
    gyro_rate_max: float = 1000.0  # °/s per sample - very high threshold
    
    # GPS bounds
    altitude_min: float = -500.0  # Allow below sea level
    altitude_max: float = 10000.0  # High altitude
    
    # GPS speed-distance consistency - DISABLED effectively (very high ratio)
    # Mock data GPS is a fixed circle, doesn't correlate with speed
    gps_speed_distance_ratio: float = 20.0  # Was 3.0, now very lenient
    
    # Impossible GPS speed (m/s) - only flag extreme jumps
    gps_impossible_speed: float = 500.0  # Was 100, now only flag huge jumps
    
    # GPS altitude rate limit (m per sample at 0.2s interval)
    altitude_rate_max: float = 50.0  # Was 5.0, now 50m per sample
    
    # GPS track coherence (MAD multiplier) - not currently used
    track_coherence_mad_mult: float = 10.0  # Was 5.0
    
    # Speed bounds
    speed_max: float = 50.0  # m/s (180 km/h) - reasonable max
    speed_impossible_accel: float = 50.0  # Was 15, m/s change in 0.2s (250 m/s²)
    
    # Sample interval for derived calculations
    sample_interval: float = 0.2  # seconds


class OutlierSeverity(Enum):
    """Severity levels for detected outliers"""
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class OutlierReason(Enum):
    """Reason codes for outlier detection"""
    Z_SCORE_EXCEEDED = "z_score_exceeded"
    ABSOLUTE_BOUND = "absolute_bound"
    SUDDEN_JUMP = "sudden_jump"
    STUCK_SENSOR = "stuck_sensor"
    MAGNITUDE_EXCEEDED = "magnitude_exceeded"
    RATE_OF_CHANGE = "rate_of_change"
    CROSS_VALIDATION_FAILED = "cross_validation_failed"
    GPS_SPEED_MISMATCH = "gps_speed_mismatch"
    IMPOSSIBLE_SPEED = "impossible_speed"
    TRACK_DEVIATION = "track_deviation"
    ALTITUDE_RATE = "altitude_rate"
    NEGATIVE_VALUE = "negative_value"
    NON_MONOTONIC = "non_monotonic"
    IMPLAUSIBLE_INCREASE = "implausible_increase"


# ------------------------------
# Rolling Window Buffer
# ------------------------------

class RollingWindow:
    """
    Circular buffer for rolling statistics with NumPy.
    Pre-allocated for performance.
    """
    
    def __init__(self, size: int = 50):
        self.size = size
        self.buffer = np.zeros(size, dtype=np.float64)
        self.count = 0
        self.index = 0
        self._mean_cache = None
        self._std_cache = None
        self._dirty = True
    
    def push(self, value: float) -> None:
        """Add a value to the window"""
        self.buffer[self.index] = value
        self.index = (self.index + 1) % self.size
        self.count = min(self.count + 1, self.size)
        self._dirty = True
    
    def get_values(self) -> np.ndarray:
        """Get current valid values"""
        if self.count < self.size:
            return self.buffer[:self.count]
        return self.buffer
    
    def mean(self) -> float:
        """Get rolling mean"""
        if self.count == 0:
            return 0.0
        if self._dirty:
            self._update_stats()
        return self._mean_cache
    
    def std(self) -> float:
        """Get rolling standard deviation"""
        if self.count < 2:
            return 0.0
        if self._dirty:
            self._update_stats()
        return self._std_cache
    
    def _update_stats(self) -> None:
        """Update cached statistics"""
        values = self.get_values()
        if len(values) > 0:
            self._mean_cache = float(np.mean(values))
            self._std_cache = float(np.std(values)) if len(values) > 1 else 0.0
        else:
            self._mean_cache = 0.0
            self._std_cache = 0.0
        self._dirty = False
    
    def last_n(self, n: int) -> np.ndarray:
        """Get last n values (for stuck sensor detection)"""
        if self.count == 0:
            return np.array([])
        n = min(n, self.count)
        if self.count < self.size:
            return self.buffer[max(0, self.count - n):self.count]
        # Handle wraparound
        end = self.index
        start = (end - n) % self.size
        if start < end:
            return self.buffer[start:end]
        return np.concatenate([self.buffer[start:], self.buffer[:end]])
    
    def reset(self) -> None:
        """Reset the window"""
        self.buffer.fill(0)
        self.count = 0
        self.index = 0
        self._dirty = True


# ------------------------------
# GPS Track Window
# ------------------------------

class GPSTrackWindow:
    """Rolling window for GPS track analysis"""
    
    def __init__(self, size: int = 20):
        self.size = size
        self.lats = np.zeros(size, dtype=np.float64)
        self.lons = np.zeros(size, dtype=np.float64)
        self.alts = np.zeros(size, dtype=np.float64)
        self.times = np.zeros(size, dtype=np.float64)
        self.count = 0
        self.index = 0
    
    def push(self, lat: float, lon: float, alt: float, timestamp: float) -> None:
        """Add a GPS point"""
        self.lats[self.index] = lat
        self.lons[self.index] = lon
        self.alts[self.index] = alt
        self.times[self.index] = timestamp
        self.index = (self.index + 1) % self.size
        self.count = min(self.count + 1, self.size)
    
    def get_last(self) -> Optional[Tuple[float, float, float, float]]:
        """Get the previous point"""
        if self.count < 2:
            return None
        prev_idx = (self.index - 2) % self.size
        return (
            self.lats[prev_idx],
            self.lons[prev_idx],
            self.alts[prev_idx],
            self.times[prev_idx]
        )
    
    def reset(self) -> None:
        """Reset the track"""
        self.lats.fill(0)
        self.lons.fill(0)
        self.alts.fill(0)
        self.times.fill(0)
        self.count = 0
        self.index = 0


# ------------------------------
# Main Detector Class
# ------------------------------

class OutlierDetector:
    """
    NumPy-based outlier detection for telemetry data.
    Maintains rolling windows for statistical analysis.
    """
    
    # Fields that get rolling windows
    ROLLING_FIELDS = [
        "voltage_v", "current_a", "power_w",
        "gyro_x", "gyro_y", "gyro_z",
        "accel_x", "accel_y", "accel_z",
        "speed_ms"
    ]
    
    # Field categories for severity assignment
    CRITICAL_FIELDS = {"voltage_v", "current_a", "power_w"}
    
    def __init__(self, config: Optional[OutlierConfig] = None):
        self.config = config or OutlierConfig()
        
        # Rolling windows per field
        self.windows: Dict[str, RollingWindow] = {
            field: RollingWindow(self.config.window_size)
            for field in self.ROLLING_FIELDS
        }
        
        # GPS track window
        self.gps_track = GPSTrackWindow(size=20)
        
        # Cumulative value tracking
        self.last_energy = None
        self.last_distance = None
        
        # Stuck sensor detection
        self.stuck_counters: Dict[str, int] = {}
        self.last_values: Dict[str, float] = {}
        
        # Stats
        self.stats = {
            "total_messages": 0,
            "messages_with_outliers": 0,
            "outliers_by_field": {},
            "outliers_by_severity": {"info": 0, "warning": 0, "critical": 0},
            "avg_detection_time_ms": 0.0,
            "detection_times": [],
        }
    
    def reset(self) -> None:
        """Reset detector state for new session"""
        for window in self.windows.values():
            window.reset()
        self.gps_track.reset()
        self.last_energy = None
        self.last_distance = None
        self.stuck_counters.clear()
        self.last_values.clear()
        self.stats = {
            "total_messages": 0,
            "messages_with_outliers": 0,
            "outliers_by_field": {},
            "outliers_by_severity": {"info": 0, "warning": 0, "critical": 0},
            "avg_detection_time_ms": 0.0,
            "detection_times": [],
        }
        logger.info("🔄 Outlier detector state reset")
    
    def detect(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Detect outliers in a telemetry data point.
        Returns outlier info or empty dict if no outliers.
        
        Target latency: <5ms
        """
        start_time = time.perf_counter()
        
        flagged_fields: Set[str] = set()
        confidence: Dict[str, float] = {}
        reasons: Dict[str, str] = {}
        max_severity = OutlierSeverity.INFO
        
        # 1. Electrical detection
        self._detect_electrical(data, flagged_fields, confidence, reasons)
        
        # 2. IMU detection
        self._detect_imu(data, flagged_fields, confidence, reasons)
        
        # 3. GPS detection
        self._detect_gps(data, flagged_fields, confidence, reasons)
        
        # 4. Speed detection
        self._detect_speed(data, flagged_fields, confidence, reasons)
        
        # 5. Cumulative value detection
        self._detect_cumulative(data, flagged_fields, confidence, reasons)
        
        # 6. Stuck sensor detection (across all rolling fields)
        self._detect_stuck_sensors(data, flagged_fields, confidence, reasons)
        
        # Update rolling windows
        self._update_windows(data)
        
        # Determine severity
        if flagged_fields:
            if flagged_fields & self.CRITICAL_FIELDS:
                max_severity = OutlierSeverity.CRITICAL
            elif len(flagged_fields) >= 3:
                max_severity = OutlierSeverity.WARNING
            else:
                # Check confidence levels
                high_confidence = any(c > 0.9 for c in confidence.values())
                max_severity = OutlierSeverity.WARNING if high_confidence else OutlierSeverity.INFO
        
        # Calculate detection time
        detection_time = (time.perf_counter() - start_time) * 1000  # ms
        
        # Update stats
        self.stats["total_messages"] += 1
        if flagged_fields:
            self.stats["messages_with_outliers"] += 1
            self.stats["outliers_by_severity"][max_severity.value] += 1
            for f in flagged_fields:
                self.stats["outliers_by_field"][f] = self.stats["outliers_by_field"].get(f, 0) + 1
        
        # Update detection time average (keep last 100)
        self.stats["detection_times"].append(detection_time)
        if len(self.stats["detection_times"]) > 100:
            self.stats["detection_times"] = self.stats["detection_times"][-100:]
        self.stats["avg_detection_time_ms"] = sum(self.stats["detection_times"]) / len(self.stats["detection_times"])
        
        # Return result
        if not flagged_fields:
            return {}
        
        return {
            "flagged_fields": list(flagged_fields),
            "confidence": confidence,
            "reasons": reasons,
            "severity": max_severity.value
        }
    
    def _detect_electrical(
        self, 
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect electrical outliers (voltage, current, power)"""
        cfg = self.config
        
        # Voltage
        if "voltage_v" in data:
            v = data["voltage_v"]
            window = self.windows["voltage_v"]
            
            # Absolute bounds
            if v < cfg.voltage_min or v > cfg.voltage_max:
                flagged.add("voltage_v")
                confidence["voltage_v"] = 1.0
                reasons["voltage_v"] = OutlierReason.ABSOLUTE_BOUND.value
            # Z-score
            elif window.count >= 10:
                mean, std = window.mean(), window.std()
                if std > 0:
                    z = abs(v - mean) / std
                    if z > cfg.z_score_threshold:
                        flagged.add("voltage_v")
                        confidence["voltage_v"] = min(1.0, z / (cfg.z_score_threshold * 2))
                        reasons["voltage_v"] = OutlierReason.Z_SCORE_EXCEEDED.value
                # Jump detection
                if mean > 0 and abs(v - mean) / mean > cfg.electrical_jump_pct:
                    if "voltage_v" not in flagged:
                        flagged.add("voltage_v")
                        confidence["voltage_v"] = 0.7
                        reasons["voltage_v"] = OutlierReason.SUDDEN_JUMP.value
        
        # Current
        if "current_a" in data:
            c = data["current_a"]
            window = self.windows["current_a"]
            
            if c < cfg.current_min or c > cfg.current_max:
                flagged.add("current_a")
                confidence["current_a"] = 1.0
                reasons["current_a"] = OutlierReason.ABSOLUTE_BOUND.value
            elif window.count >= 10:
                mean, std = window.mean(), window.std()
                if std > 0:
                    z = abs(c - mean) / std
                    if z > cfg.z_score_threshold:
                        flagged.add("current_a")
                        confidence["current_a"] = min(1.0, z / (cfg.z_score_threshold * 2))
                        reasons["current_a"] = OutlierReason.Z_SCORE_EXCEEDED.value
        
        # Power
        if "power_w" in data:
            p = data["power_w"]
            
            if p < cfg.power_min or p > cfg.power_max:
                flagged.add("power_w")
                confidence["power_w"] = 1.0
                reasons["power_w"] = OutlierReason.ABSOLUTE_BOUND.value
    
    def _detect_imu(
        self,
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect IMU outliers (gyro, accel)"""
        cfg = self.config
        
        # Total acceleration magnitude
        ax = data.get("accel_x", 0)
        ay = data.get("accel_y", 0)
        az = data.get("accel_z", 0)
        
        if any(f in data for f in ["accel_x", "accel_y", "accel_z"]):
            magnitude = math.sqrt(ax**2 + ay**2 + az**2)
            if magnitude > cfg.accel_magnitude_max:
                # Flag the primary axis
                max_axis = max([("accel_x", abs(ax)), ("accel_y", abs(ay)), ("accel_z", abs(az))], key=lambda x: x[1])
                flagged.add(max_axis[0])
                confidence[max_axis[0]] = min(1.0, magnitude / cfg.accel_magnitude_max)
                reasons[max_axis[0]] = OutlierReason.MAGNITUDE_EXCEEDED.value
        
        # Gyro rate of change
        for gyro_field in ["gyro_x", "gyro_y", "gyro_z"]:
            if gyro_field in data:
                window = self.windows[gyro_field]
                if window.count > 0:
                    last_vals = window.last_n(1)
                    if len(last_vals) > 0:
                        rate = abs(data[gyro_field] - last_vals[0])
                        if rate > cfg.gyro_rate_max:
                            flagged.add(gyro_field)
                            confidence[gyro_field] = min(1.0, rate / (cfg.gyro_rate_max * 2))
                            reasons[gyro_field] = OutlierReason.RATE_OF_CHANGE.value
        
        # Cross-validation: stationary accel vs high gyro
        speed = data.get("speed_ms", 0)
        if speed < 0.5:  # Nearly stationary
            # At rest, accel should be ~9.81 and gyro should be ~0
            gyro_mag = math.sqrt(
                data.get("gyro_x", 0)**2 + 
                data.get("gyro_y", 0)**2 + 
                data.get("gyro_z", 0)**2
            )
            if gyro_mag > 10:  # High rotation while stationary
                if "gyro_z" in data and "gyro_z" not in flagged:
                    flagged.add("gyro_z")
                    confidence["gyro_z"] = 0.6
                    reasons["gyro_z"] = OutlierReason.CROSS_VALIDATION_FAILED.value
    
    def _detect_gps(
        self,
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect GPS outliers (lat, lon, alt, speed consistency)"""
        cfg = self.config
        
        lat = data.get("latitude")
        lon = data.get("longitude")
        alt = data.get("altitude", 0)
        speed = data.get("speed_ms", 0)
        
        if lat is None or lon is None:
            return
        
        # 1. Absolute bounds
        if not (-90 <= lat <= 90):
            flagged.add("latitude")
            confidence["latitude"] = 1.0
            reasons["latitude"] = OutlierReason.ABSOLUTE_BOUND.value
        
        if not (-180 <= lon <= 180):
            flagged.add("longitude")
            confidence["longitude"] = 1.0
            reasons["longitude"] = OutlierReason.ABSOLUTE_BOUND.value
        
        if alt < cfg.altitude_min or alt > cfg.altitude_max:
            flagged.add("altitude")
            confidence["altitude"] = 1.0
            reasons["altitude"] = OutlierReason.ABSOLUTE_BOUND.value
        
        # Get previous point for movement analysis
        prev = self.gps_track.get_last()
        if prev is not None:
            prev_lat, prev_lon, prev_alt, prev_time = prev
            
            # 2. Calculate distance (Haversine approximation for small distances)
            dlat = lat - prev_lat
            dlon = lon - prev_lon
            # Approximate meters (at 45° latitude, 1 degree ≈ 111km lat, 78km lon)
            dist_m = math.sqrt((dlat * 111000)**2 + (dlon * 78000)**2)
            
            # Time delta (use sample interval if timestamp not available)
            dt = cfg.sample_interval
            
            # 3. Speed-distance consistency
            expected_dist = speed * dt
            if expected_dist > 0:
                ratio = dist_m / expected_dist
                if ratio > cfg.gps_speed_distance_ratio:
                    flagged.add("latitude")
                    confidence["latitude"] = min(1.0, ratio / (cfg.gps_speed_distance_ratio * 2))
                    reasons["latitude"] = OutlierReason.GPS_SPEED_MISMATCH.value
            
            # 4. Impossible speed (GPS-derived)
            implied_speed = dist_m / dt
            if implied_speed > cfg.gps_impossible_speed:
                if "latitude" not in flagged:
                    flagged.add("latitude")
                    confidence["latitude"] = min(1.0, implied_speed / (cfg.gps_impossible_speed * 2))
                    reasons["latitude"] = OutlierReason.IMPOSSIBLE_SPEED.value
            
            # 5. Altitude rate limit
            alt_change = abs(alt - prev_alt)
            if alt_change > cfg.altitude_rate_max:
                if "altitude" not in flagged:
                    flagged.add("altitude")
                    confidence["altitude"] = min(1.0, alt_change / (cfg.altitude_rate_max * 2))
                    reasons["altitude"] = OutlierReason.ALTITUDE_RATE.value
        
        # Update GPS track
        self.gps_track.push(lat, lon, alt, time.time())
    
    def _detect_speed(
        self,
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect speed outliers"""
        cfg = self.config
        
        if "speed_ms" not in data:
            return
        
        speed = data["speed_ms"]
        window = self.windows["speed_ms"]
        
        # Negative speed
        if speed < 0:
            flagged.add("speed_ms")
            confidence["speed_ms"] = 1.0
            reasons["speed_ms"] = OutlierReason.NEGATIVE_VALUE.value
            return
        
        # Max speed
        if speed > cfg.speed_max:
            flagged.add("speed_ms")
            confidence["speed_ms"] = min(1.0, speed / (cfg.speed_max * 1.5))
            reasons["speed_ms"] = OutlierReason.ABSOLUTE_BOUND.value
            return
        
        # Impossible acceleration
        if window.count > 0:
            last_vals = window.last_n(1)
            if len(last_vals) > 0:
                accel = abs(speed - last_vals[0]) / cfg.sample_interval
                if accel > cfg.speed_impossible_accel:
                    flagged.add("speed_ms")
                    confidence["speed_ms"] = min(1.0, accel / (cfg.speed_impossible_accel * 2))
                    reasons["speed_ms"] = OutlierReason.RATE_OF_CHANGE.value
    
    def _detect_cumulative(
        self,
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect cumulative value outliers (energy, distance)"""
        
        # Energy should be monotonically increasing
        if "energy_j" in data:
            energy = data["energy_j"]
            if self.last_energy is not None:
                if energy < self.last_energy:
                    flagged.add("energy_j")
                    confidence["energy_j"] = 1.0
                    reasons["energy_j"] = OutlierReason.NON_MONOTONIC.value
                elif energy - self.last_energy > 50000:  # Implausible increase
                    flagged.add("energy_j")
                    confidence["energy_j"] = 0.8
                    reasons["energy_j"] = OutlierReason.IMPLAUSIBLE_INCREASE.value
            self.last_energy = energy
        
        # Distance should be monotonically increasing
        if "distance_m" in data:
            distance = data["distance_m"]
            if self.last_distance is not None:
                if distance < self.last_distance:
                    flagged.add("distance_m")
                    confidence["distance_m"] = 1.0
                    reasons["distance_m"] = OutlierReason.NON_MONOTONIC.value
                elif distance - self.last_distance > 100:  # 100m in 0.2s = 500 m/s = impossible
                    flagged.add("distance_m")
                    confidence["distance_m"] = 0.8
                    reasons["distance_m"] = OutlierReason.IMPLAUSIBLE_INCREASE.value
            self.last_distance = distance
    
    def _detect_stuck_sensors(
        self,
        data: Dict[str, Any],
        flagged: Set[str],
        confidence: Dict[str, float],
        reasons: Dict[str, str]
    ) -> None:
        """Detect stuck/frozen sensor values"""
        cfg = self.config
        
        for field in self.ROLLING_FIELDS:
            if field not in data:
                continue
            
            val = data[field]
            
            # Check if value is identical to last
            if field in self.last_values and self.last_values[field] == val:
                self.stuck_counters[field] = self.stuck_counters.get(field, 0) + 1
                if self.stuck_counters[field] >= cfg.stuck_sensor_count:
                    if field not in flagged:
                        flagged.add(field)
                        confidence[field] = min(1.0, self.stuck_counters[field] / (cfg.stuck_sensor_count * 2))
                        reasons[field] = OutlierReason.STUCK_SENSOR.value
            else:
                self.stuck_counters[field] = 0
            
            self.last_values[field] = val
    
    def _update_windows(self, data: Dict[str, Any]) -> None:
        """Update rolling windows with new data"""
        for field in self.ROLLING_FIELDS:
            if field in data:
                self.windows[field].push(data[field])
    
    def get_stats(self) -> Dict[str, Any]:
        """Get detection statistics"""
        return {
            **self.stats,
            "outliers_by_field": dict(self.stats["outliers_by_field"]),
        }


# ------------------------------
# Standalone Testing
# ------------------------------

def run_detector_test():
    """Test the outlier detector with mock data"""
    import sys
    sys.path.insert(0, '.')
    
    try:
        from mock_generator import MockScenario, MockModeConfig, MockDataGenerator
    except ImportError:
        print("mock_generator module not found, using inline test data")
        return
    
    print("Testing OutlierDetector with CHAOS mode...\n")
    
    # Create detector and generator
    detector = OutlierDetector()
    config = MockModeConfig.from_scenario(MockScenario.CHAOS)
    generator = MockDataGenerator(config=config)
    
    # Generate and analyze 200 points
    outlier_count = 0
    for i in range(200):
        data = generator.generate()
        if data is None:
            continue
        
        result = detector.detect(data)
        if result:
            outlier_count += 1
            if i < 50:  # Show first few
                print(f"[{i}] Outliers: {result['flagged_fields']} - {result['severity']}")
    
    # Print stats
    stats = detector.get_stats()
    print(f"\n--- Detection Stats ---")
    print(f"Total messages: {stats['total_messages']}")
    print(f"Messages with outliers: {stats['messages_with_outliers']}")
    print(f"Outliers by severity: {stats['outliers_by_severity']}")
    print(f"Avg detection time: {stats['avg_detection_time_ms']:.3f}ms")
    print(f"Outliers by field: {stats['outliers_by_field']}")
    
    # Check latency requirement
    if stats['avg_detection_time_ms'] < 5.0:
        print(f"\n✅ Latency requirement met (<5ms)")
    else:
        print(f"\n❌ Latency requirement NOT met (>5ms)")


if __name__ == "__main__":
    run_detector_test()
