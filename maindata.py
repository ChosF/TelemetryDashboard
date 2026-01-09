# maindata.py
import asyncio
import csv
import json
import logging
import math
import os
import random
import signal
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
import threading
import queue
import struct

try:
    import numpy as np
except ImportError:
    print("Error: NumPy library not installed. Run: pip install numpy")
    sys.exit(1)

try:
    from ably import AblyRealtime
except ImportError:
    print("Error: Ably library not installed. Run: pip install ably")
    sys.exit(1)

try:
    from supabase import create_client, Client
except ImportError:
    print("Error: Supabase library not installed. Run: pip install supabase")
    sys.exit(1)

# ------------------------------
# Configuration
# ------------------------------

# ESP32 MQTT source
ESP32_ABLY_API_KEY = (
    "ja_fwQ.K6CTEw:F-aWFMdJXPCv9MvxhYztCGna3XdRJZVgA0qm9pMfDOQ"
)
ESP32_CHANNEL_NAME = "EcoTele"

# Dashboard output
DASHBOARD_ABLY_API_KEY = (
    "DxuYSw.fQHpug:sa4tOcqWDkYBW9ht56s7fT0G091R1fyXQc6mc8WthxQ"
)
DASHBOARD_CHANNEL_NAME = "telemetry-dashboard-channel"

# Supabase
SUPABASE_URL = "https://dsfmdziehhgmrconjcns.supabase.co"
SUPABASE_API_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzZm1keml"
    "laGhnbXJjb25qY25zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5MDEyOTIsImV4cCI6MjA2NzQ3NzI5Mn0"
    ".P41bpLkP0tKpTktLx6hFOnnyrAB9N_yihQP1v6zTRwc"
)
SUPABASE_TABLE_NAME = "telemetry"

# Timings
MOCK_DATA_INTERVAL = 0.2  # seconds
DB_BATCH_INTERVAL = 9.0  # seconds
MAX_BATCH_SIZE = 200  # records per insert
RETRY_BASE_BACKOFF = 3.0  # seconds
RETRY_BACKOFF_MAX = 60.0  # seconds

# Reliability settings
CONNECTION_TIMEOUT = 15.0  # seconds
WATCHDOG_TIMEOUT = 30.0  # seconds - trigger reconnect if no data
HEALTH_CHECK_INTERVAL = 10.0  # seconds
MAX_QUEUE_SIZE = 5000  # prevent memory issues
RECONNECT_MAX_ATTEMPTS = 10
RECONNECT_BASE_DELAY = 1.0  # seconds

# Durability paths
SPOOL_DIR = "./spool"
EXPORT_DIR = "./export"

# Rate limiting for Ably publishing (to prevent exceeding 600 msg/sec limit)
PUBLISH_RATE_LIMIT = 500  # messages per second (Ably limit is 600)
PUBLISH_BURST_CAPACITY = 50  # allow small bursts before rate limiting kicks in
PUBLISH_QUEUE_MAX_SIZE = 10000  # max queue size during disconnection
PUBLISH_DRAIN_INTERVAL = 0.002  # 2ms between messages during controlled drain

# Outlier Detection Configuration
OUTLIER_ROLLING_WINDOW_SIZE = 50  # samples for rolling statistics
OUTLIER_ZSCORE_THRESHOLD = 4.0  # sigma threshold for Z-score detection
OUTLIER_STUCK_SENSOR_COUNT = 10  # consecutive identical values to flag stuck
OUTLIER_GPS_SPEED_FACTOR = 3.0  # max ratio of GPS distance vs expected
OUTLIER_GPS_MAX_SPEED = 100.0  # m/s (360 km/h) - impossible GPS jump speed
OUTLIER_GPS_TRAJECTORY_WINDOW = 20  # samples for trajectory coherence
OUTLIER_ALTITUDE_MAX_CHANGE = 5.0  # meters per 0.2s sample

# Electrical sensor bounds
VOLTAGE_MIN = 40.0  # V
VOLTAGE_MAX = 60.0  # V
CURRENT_MIN = -5.0  # A (regenerative braking)
CURRENT_MAX = 30.0  # A
POWER_MIN = -200.0  # W
POWER_MAX = 2000.0  # W
SPEED_MAX = 40.0  # m/s (144 km/h)

# Logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("TelemetryBridge")


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
# Rate-Limited Publisher
# ------------------------------

class RateLimitedPublisher:
    """
    Token bucket rate limiter for Ably message publishing.
    Prevents exceeding Ably's message rate limits during bursts.
    """

    def __init__(
        self,
        rate_limit: float = PUBLISH_RATE_LIMIT,
        burst_capacity: int = PUBLISH_BURST_CAPACITY,
        max_queue_size: int = PUBLISH_QUEUE_MAX_SIZE,
        drain_interval: float = PUBLISH_DRAIN_INTERVAL,
    ):
        self.rate_limit = rate_limit
        self.burst_capacity = burst_capacity
        self.max_queue_size = max_queue_size
        self.drain_interval = drain_interval

        # Token bucket state
        self.tokens = float(burst_capacity)
        self.last_refill_time = time.monotonic()
        self.refill_rate = rate_limit  # tokens per second

        # Message queue for burst accumulation
        self._queue: asyncio.Queue = None  # Initialized in async context
        self._is_connected = False
        self._drain_task: Optional[asyncio.Task] = None

        # Statistics
        self.stats = {
            "queue_depth": 0,
            "burst_events": 0,
            "max_queue_depth_reached": 0,
            "messages_delayed": 0,
            "messages_published": 0,
            "messages_dropped": 0,
        }

        self._lock = asyncio.Lock()

    async def initialize(self):
        """Initialize async components"""
        self._queue = asyncio.Queue(maxsize=self.max_queue_size)

    def _refill_tokens(self) -> None:
        """Refill tokens based on elapsed time"""
        now = time.monotonic()
        elapsed = now - self.last_refill_time
        self.last_refill_time = now

        # Add tokens based on time elapsed
        self.tokens = min(
            self.burst_capacity,
            self.tokens + elapsed * self.refill_rate
        )

    async def enqueue(self, message: Dict[str, Any]) -> bool:
        """
        Add a message to the publishing queue.
        Returns True if queued, False if dropped due to full queue.
        """
        if self._queue is None:
            await self.initialize()

        try:
            self._queue.put_nowait(message)
            self.stats["queue_depth"] = self._queue.qsize()
            self.stats["max_queue_depth_reached"] = max(
                self.stats["max_queue_depth_reached"],
                self._queue.qsize()
            )
            return True
        except asyncio.QueueFull:
            # Drop oldest message to make room
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(message)
                self.stats["messages_dropped"] += 1
                return True
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                return False

    async def publish_immediately(
        self,
        channel,
        message: Dict[str, Any],
        event_name: str = "telemetry_update"
    ) -> bool:
        """
        Attempt to publish immediately if rate allows, otherwise queue.
        Returns True if published immediately, False if queued/dropped.
        """
        async with self._lock:
            self._refill_tokens()

            if self.tokens >= 1.0:
                # Have capacity - publish immediately
                self.tokens -= 1.0
                try:
                    await channel.publish(event_name, message)
                    self.stats["messages_published"] += 1
                    return True
                except Exception as e:
                    logger.error(f"❌ Rate limiter publish failed: {e}")
                    # Queue for retry
                    await self.enqueue(message)
                    return False
            else:
                # Rate limited - queue the message
                self.stats["messages_delayed"] += 1
                if self.stats["messages_delayed"] % 100 == 1:
                    self.stats["burst_events"] += 1
                    logger.warning(f"⚠️ Rate limit burst - queueing messages (depth: {self._queue.qsize() if self._queue else 0})")
                await self.enqueue(message)
                return False

    async def drain_queue(self, channel, event_name: str = "telemetry_update"):
        """Drain queued messages at controlled rate"""
        if self._queue is None:
            return

        while not self._queue.empty():
            try:
                message = await asyncio.wait_for(
                    self._queue.get(),
                    timeout=0.1
                )
            except asyncio.TimeoutError:
                break

            async with self._lock:
                self._refill_tokens()

                # Wait if no tokens available
                if self.tokens < 1.0:
                    wait_time = (1.0 - self.tokens) / self.refill_rate
                    await asyncio.sleep(min(wait_time, self.drain_interval))
                    self._refill_tokens()

                self.tokens = max(0, self.tokens - 1.0)

            try:
                await channel.publish(event_name, message)
                self.stats["messages_published"] += 1
            except Exception as e:
                logger.error(f"❌ Drain publish failed: {e}")
                # Re-queue at front
                try:
                    self._queue.put_nowait(message)
                except asyncio.QueueFull:
                    self.stats["messages_dropped"] += 1

            self.stats["queue_depth"] = self._queue.qsize()
            await asyncio.sleep(self.drain_interval)

    def set_connected(self, connected: bool):
        """Update connection state"""
        self._is_connected = connected

    def get_stats(self) -> Dict[str, Any]:
        """Get current statistics"""
        self.stats["queue_depth"] = self._queue.qsize() if self._queue else 0
        return self.stats.copy()


# ------------------------------
# Outlier Detection Engine
# ------------------------------

class OutlierDetector:
    """
    High-performance outlier detection using NumPy.
    Designed for <5ms latency per message.
    """

    def __init__(
        self,
        window_size: int = OUTLIER_ROLLING_WINDOW_SIZE,
        zscore_threshold: float = OUTLIER_ZSCORE_THRESHOLD,
        stuck_count: int = OUTLIER_STUCK_SENSOR_COUNT,
    ):
        self.window_size = window_size
        self.zscore_threshold = zscore_threshold
        self.stuck_count = stuck_count

        # Pre-allocated rolling windows (NumPy arrays for speed)
        self._windows: Dict[str, np.ndarray] = {}
        self._window_idx: Dict[str, int] = {}
        self._window_filled: Dict[str, bool] = {}

        # GPS trajectory history
        self._gps_history: List[Dict[str, float]] = []
        self._gps_max_history = OUTLIER_GPS_TRAJECTORY_WINDOW

        # Stuck sensor counters
        self._last_values: Dict[str, float] = {}
        self._stuck_counters: Dict[str, int] = {}

        # Previous message for rate-of-change detection
        self._prev_message: Optional[Dict[str, Any]] = None
        self._prev_timestamp: Optional[float] = None

        # Sensor groups for detection
        self._electrical_fields = ["voltage_v", "current_a", "power_w"]
        self._imu_fields = ["gyro_x", "gyro_y", "gyro_z", "accel_x", "accel_y", "accel_z"]
        self._gps_fields = ["latitude", "longitude", "altitude"]

        # Performance tracking
        self._detection_times: List[float] = []

    def _get_or_create_window(self, field: str) -> np.ndarray:
        """Get or create a rolling window for a field"""
        if field not in self._windows:
            self._windows[field] = np.zeros(self.window_size, dtype=np.float64)
            self._window_idx[field] = 0
            self._window_filled[field] = False
        return self._windows[field]

    def _add_to_window(self, field: str, value: float) -> None:
        """Add a value to the rolling window"""
        window = self._get_or_create_window(field)
        idx = self._window_idx[field]
        window[idx] = value
        self._window_idx[field] = (idx + 1) % self.window_size
        if idx == self.window_size - 1:
            self._window_filled[field] = True

    def _get_window_stats(self, field: str) -> tuple:
        """Get mean and std of the rolling window"""
        if field not in self._windows:
            return None, None
        window = self._windows[field]
        if self._window_filled.get(field, False):
            return np.mean(window), np.std(window)
        else:
            idx = self._window_idx[field]
            if idx < 3:
                return None, None
            valid = window[:idx]
            return np.mean(valid), np.std(valid)

    def _check_stuck_sensor(self, field: str, value: float) -> bool:
        """Check if sensor is stuck (identical values)"""
        last_val = self._last_values.get(field)
        if last_val is not None and abs(value - last_val) < 1e-9:
            self._stuck_counters[field] = self._stuck_counters.get(field, 0) + 1
        else:
            self._stuck_counters[field] = 0
        self._last_values[field] = value
        return self._stuck_counters.get(field, 0) >= self.stuck_count

    def _haversine_distance(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate Haversine distance between two GPS points in meters"""
        R = 6371000  # Earth radius in meters
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    def detect(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Run all outlier detection on a message.
        Returns outlier info dict or None if no outliers.
        Target: <5ms processing time.
        """
        start_time = time.perf_counter()

        flagged_fields: List[str] = []
        confidence: Dict[str, float] = {}
        reasons: Dict[str, str] = {}

        try:
            # Get timestamp delta for rate-of-change detection
            dt = MOCK_DATA_INTERVAL  # default
            timestamp_str = data.get("timestamp")
            if timestamp_str and self._prev_timestamp:
                try:
                    ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00")).timestamp()
                    dt = max(0.01, ts - self._prev_timestamp)
                except Exception:
                    pass

            # 1. Electrical sensor outliers
            self._detect_electrical(data, flagged_fields, confidence, reasons, dt)

            # 2. IMU sensor outliers
            self._detect_imu(data, flagged_fields, confidence, reasons, dt)

            # 3. GPS outliers (most complex)
            self._detect_gps(data, flagged_fields, confidence, reasons, dt)

            # 4. Speed outliers
            self._detect_speed(data, flagged_fields, confidence, reasons, dt)

            # 5. Cumulative outliers (energy_j, distance_m)
            self._detect_cumulative(data, flagged_fields, confidence, reasons)

            # Update rolling windows with current values
            for field in self._electrical_fields + ["speed_ms"]:
                val = data.get(field)
                if val is not None and isinstance(val, (int, float)):
                    self._add_to_window(field, float(val))

            # Update GPS history
            lat, lon = data.get("latitude"), data.get("longitude")
            if lat is not None and lon is not None:
                self._gps_history.append({
                    "lat": lat, "lon": lon,
                    "alt": data.get("altitude", 0),
                    "speed": data.get("speed_ms", 0),
                    "ts": time.time()
                })
                if len(self._gps_history) > self._gps_max_history:
                    self._gps_history.pop(0)

            # Store for next iteration
            if timestamp_str:
                try:
                    self._prev_timestamp = datetime.fromisoformat(
                        timestamp_str.replace("Z", "+00:00")
                    ).timestamp()
                except Exception:
                    pass
            self._prev_message = data.copy()

        except Exception as e:
            logger.error(f"❌ Outlier detection error: {e}")

        # Track performance
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        self._detection_times.append(elapsed_ms)
        if len(self._detection_times) > 100:
            self._detection_times.pop(0)

        # Return outlier info if any flagged
        if flagged_fields:
            # Determine severity
            max_conf = max(confidence.values()) if confidence else 0
            if max_conf >= 0.9 or len(flagged_fields) >= 3:
                severity = "critical"
            elif max_conf >= 0.7 or len(flagged_fields) >= 2:
                severity = "warning"
            else:
                severity = "info"

            return {
                "flagged_fields": flagged_fields,
                "confidence": confidence,
                "reasons": reasons,
                "severity": severity,
            }
        return None

    def _detect_electrical(
        self,
        data: Dict[str, Any],
        flagged: List[str],
        conf: Dict[str, float],
        reasons: Dict[str, str],
        dt: float
    ):
        """Detect electrical sensor outliers"""
        bounds = {
            "voltage_v": (VOLTAGE_MIN, VOLTAGE_MAX),
            "current_a": (CURRENT_MIN, CURRENT_MAX),
            "power_w": (POWER_MIN, POWER_MAX),
        }

        for field, (min_val, max_val) in bounds.items():
            val = data.get(field)
            if val is None or not isinstance(val, (int, float)):
                continue

            # Absolute bounds check
            if val < min_val or val > max_val:
                flagged.append(field)
                conf[field] = 0.95
                reasons[field] = f"out_of_bounds_{min_val}_{max_val}"
                continue

            # Z-score check
            mean, std = self._get_window_stats(field)
            if mean is not None and std is not None and std > 0.01:
                zscore = abs((val - mean) / std)
                if zscore > self.zscore_threshold:
                    flagged.append(field)
                    conf[field] = min(0.99, 0.5 + zscore / 10)
                    reasons[field] = "exceeded_z_score_threshold"
                    continue

            # Sudden jump detection (>20% of mean)
            if mean is not None and mean != 0:
                change_pct = abs(val - mean) / abs(mean)
                if change_pct > 0.2:
                    flagged.append(field)
                    conf[field] = min(0.85, 0.5 + change_pct)
                    reasons[field] = "sudden_jump"
                    continue

            # Stuck sensor detection
            if self._check_stuck_sensor(field, val):
                flagged.append(field)
                conf[field] = 0.8
                reasons[field] = "stuck_sensor"

    def _detect_imu(
        self,
        data: Dict[str, Any],
        flagged: List[str],
        conf: Dict[str, float],
        reasons: Dict[str, str],
        dt: float
    ):
        """Detect IMU sensor outliers"""
        # Get accelerometer values
        ax = data.get("accel_x", 0)
        ay = data.get("accel_y", 0)
        az = data.get("accel_z", 0)

        # Magnitude check - should be near 9.81 when stationary
        if all(isinstance(v, (int, float)) for v in [ax, ay, az]):
            total_accel = math.sqrt(ax**2 + ay**2 + az**2)
            if total_accel > 50:  # Physically implausible
                for field in ["accel_x", "accel_y", "accel_z"]:
                    flagged.append(field)
                    conf[field] = 0.95
                    reasons[field] = "implausible_acceleration"

        # Gyroscope rate-of-change check
        if self._prev_message:
            for field in ["gyro_x", "gyro_y", "gyro_z"]:
                curr = data.get(field)
                prev = self._prev_message.get(field)
                if curr is not None and prev is not None:
                    rate = abs(curr - prev) / dt if dt > 0 else 0
                    if rate > 500:  # >500°/s change is implausible
                        flagged.append(field)
                        conf[field] = 0.85
                        reasons[field] = "excessive_rate_of_change"

        # Stuck sensor detection for IMU
        for field in self._imu_fields:
            val = data.get(field)
            if val is not None and isinstance(val, (int, float)):
                if self._check_stuck_sensor(field, val):
                    if field not in flagged:
                        flagged.append(field)
                        conf[field] = 0.75
                        reasons[field] = "stuck_sensor"

    def _detect_gps(
        self,
        data: Dict[str, Any],
        flagged: List[str],
        conf: Dict[str, float],
        reasons: Dict[str, str],
        dt: float
    ):
        """Multi-layer GPS outlier detection"""
        lat = data.get("latitude")
        lon = data.get("longitude")
        alt = data.get("altitude")
        speed = data.get("speed_ms", 0)

        if lat is None or lon is None:
            return

        # Layer 1: Absolute bounds
        if not (-90 <= lat <= 90):
            flagged.append("latitude")
            conf["latitude"] = 1.0
            reasons["latitude"] = "invalid_latitude_range"
        if not (-180 <= lon <= 180):
            flagged.append("longitude")
            conf["longitude"] = 1.0
            reasons["longitude"] = "invalid_longitude_range"
        if alt is not None and not (-500 <= alt <= 10000):
            flagged.append("altitude")
            conf["altitude"] = 0.9
            reasons["altitude"] = "implausible_altitude"

        # Layer 2: Speed-distance consistency
        if self._gps_history and len(self._gps_history) >= 1:
            prev = self._gps_history[-1]
            gps_dist = self._haversine_distance(prev["lat"], prev["lon"], lat, lon)
            expected_dist = speed * dt if speed >= 0 else 0

            # GPS implies impossible speed
            gps_speed = gps_dist / dt if dt > 0 else 0
            if gps_speed > OUTLIER_GPS_MAX_SPEED:
                if "latitude" not in flagged:
                    flagged.append("latitude")
                    conf["latitude"] = 0.9
                    reasons["latitude"] = "gps_impossible_jump"
                if "longitude" not in flagged:
                    flagged.append("longitude")
                    conf["longitude"] = 0.9
                    reasons["longitude"] = "gps_impossible_jump"

            # GPS distance vs expected (from speed)
            if expected_dist > 0.1:  # At least 10cm expected movement
                ratio = gps_dist / expected_dist if expected_dist > 0 else float("inf")
                if ratio > OUTLIER_GPS_SPEED_FACTOR:
                    if "latitude" not in flagged:
                        flagged.append("latitude")
                        conf["latitude"] = min(0.85, 0.5 + ratio / 10)
                        reasons["latitude"] = "gps_speed_inconsistent"
                    if "longitude" not in flagged:
                        flagged.append("longitude")
                        conf["longitude"] = min(0.85, 0.5 + ratio / 10)
                        reasons["longitude"] = "gps_speed_inconsistent"

        # Layer 4: Track coherence using MAD
        if len(self._gps_history) >= 5:
            recent_lats = np.array([p["lat"] for p in self._gps_history[-5:]])
            recent_lons = np.array([p["lon"] for p in self._gps_history[-5:]])

            lat_median = np.median(recent_lats)
            lon_median = np.median(recent_lons)
            lat_mad = np.median(np.abs(recent_lats - lat_median))
            lon_mad = np.median(np.abs(recent_lons - lon_median))

            if lat_mad > 0:
                lat_dev = abs(lat - lat_median) / (lat_mad * 1.4826)  # Scale to std
                if lat_dev > 5:  # 5 MAD-scaled deviations
                    if "latitude" not in flagged:
                        flagged.append("latitude")
                        conf["latitude"] = min(0.8, 0.5 + lat_dev / 10)
                        reasons["latitude"] = "trajectory_deviation"

            if lon_mad > 0:
                lon_dev = abs(lon - lon_median) / (lon_mad * 1.4826)
                if lon_dev > 5:
                    if "longitude" not in flagged:
                        flagged.append("longitude")
                        conf["longitude"] = min(0.8, 0.5 + lon_dev / 10)
                        reasons["longitude"] = "trajectory_deviation"

        # Layer 5: Altitude consistency
        if alt is not None and self._gps_history:
            prev_alt = self._gps_history[-1].get("alt")
            if prev_alt is not None:
                alt_change = abs(alt - prev_alt)
                if alt_change > OUTLIER_ALTITUDE_MAX_CHANGE:
                    if "altitude" not in flagged:
                        flagged.append("altitude")
                        conf["altitude"] = min(0.85, 0.5 + alt_change / 10)
                        reasons["altitude"] = "excessive_altitude_change"

    def _detect_speed(
        self,
        data: Dict[str, Any],
        flagged: List[str],
        conf: Dict[str, float],
        reasons: Dict[str, str],
        dt: float
    ):
        """Detect speed outliers"""
        speed = data.get("speed_ms")
        if speed is None or not isinstance(speed, (int, float)):
            return

        # Negative speed check
        if speed < 0:
            flagged.append("speed_ms")
            conf["speed_ms"] = 0.95
            reasons["speed_ms"] = "negative_speed"
            return

        # Maximum speed check
        if speed > SPEED_MAX:
            flagged.append("speed_ms")
            conf["speed_ms"] = 0.9
            reasons["speed_ms"] = "exceeds_physical_maximum"
            return

        # Impossible acceleration
        if self._prev_message:
            prev_speed = self._prev_message.get("speed_ms", 0)
            if prev_speed is not None:
                accel = abs(speed - prev_speed) / dt if dt > 0 else 0
                if accel > 75:  # >7.6g
                    flagged.append("speed_ms")
                    conf["speed_ms"] = 0.85
                    reasons["speed_ms"] = "impossible_acceleration"

    def _detect_cumulative(
        self,
        data: Dict[str, Any],
        flagged: List[str],
        conf: Dict[str, float],
        reasons: Dict[str, str]
    ):
        """Detect cumulative field outliers (energy_j, distance_m)"""
        if not self._prev_message:
            return

        for field in ["energy_j", "distance_m"]:
            curr = data.get(field)
            prev = self._prev_message.get(field)
            if curr is None or prev is None:
                continue
            if not isinstance(curr, (int, float)) or not isinstance(prev, (int, float)):
                continue

            # Should be monotonically increasing
            if curr < prev:
                flagged.append(field)
                conf[field] = 0.85
                reasons[field] = "decreased_cumulative"

    def get_avg_latency_ms(self) -> float:
        """Get average detection latency"""
        if not self._detection_times:
            return 0.0
        return sum(self._detection_times) / len(self._detection_times)

    def reset(self):
        """Reset all state for new session"""
        self._windows.clear()
        self._window_idx.clear()
        self._window_filled.clear()
        self._gps_history.clear()
        self._last_values.clear()
        self._stuck_counters.clear()
        self._prev_message = None
        self._prev_timestamp = None
        self._detection_times.clear()


# ------------------------------
# Connection Health Monitor
# ------------------------------

@dataclass
class ConnectionHealth:
    """Tracks connection health and metrics"""
    is_connected: bool = False
    last_message_time: float = 0.0
    last_health_check: float = 0.0
    reconnect_attempts: int = 0
    total_reconnects: int = 0
    messages_since_connect: int = 0
    error_count: int = 0
    error_rate: float = 0.0  # errors per minute
    last_error_time: float = 0.0
    
    def record_message(self):
        self.last_message_time = time.monotonic()
        self.messages_since_connect += 1
        
    def record_error(self):
        now = time.monotonic()
        self.error_count += 1
        # Calculate rolling error rate (errors in last minute)
        if now - self.last_error_time > 60:
            self.error_rate = 1.0
        else:
            self.error_rate = min(100, self.error_rate + 1)
        self.last_error_time = now
        
    def is_stale(self, timeout: float) -> bool:
        if self.last_message_time == 0:
            return False
        return time.monotonic() - self.last_message_time > timeout
        
    def reset_for_reconnect(self):
        self.is_connected = False
        self.reconnect_attempts += 1
        self.total_reconnects += 1
        self.messages_since_connect = 0


# ------------------------------
# Local durable journal
# ------------------------------

class LocalJournal:
    """
    Append-only NDJSON per session to guarantee durability.
    """

    def __init__(self, spool_dir: str, session_id: str):
        os.makedirs(spool_dir, exist_ok=True)
        self.path = os.path.join(spool_dir, f"{session_id}.ndjson")
        self._fh = open(self.path, "a", buffering=1, encoding="utf-8")

    def append(self, record: Dict[str, Any]) -> None:
        try:
            self._fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.error(f"❌ Failed to append to journal: {e}")

    def close(self) -> None:
        try:
            self._fh.flush()
            self._fh.close()
        except Exception:
            pass

    def iter_records(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            return

    def export_csv(self, out_path: str, field_order: List[str]) -> int:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        n = 0
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(field_order)
            for rec in self.iter_records():
                row = []
                for col in field_order:
                    v = rec.get(col, "")
                    row.append(v)
                w.writerow(row)
                n += 1
        return n


# ------------------------------
# Bridge
# ------------------------------

class TelemetryBridgeWithDB:
    """
    - Subscribes to ESP32 (real) or generates mock data
    - Republishes to dashboard
    - Stores to Supabase in batches with retry/backoff
    - Local-first journaling (NDJSON) to avoid data loss
    - On shutdown, exports CSV if any DB failure or pending retries
    - Enhanced reliability: connection monitoring, auto-reconnect, watchdog
    - Mock mode: configurable error simulations
    """

    def __init__(
        self, 
        mock_mode: bool = False, 
        session_name: Optional[str] = None,
        mock_config: Optional[MockModeConfig] = None
    ):
        self.mock_mode = mock_mode
        self.mock_config = mock_config or MockModeConfig()
        
        self.esp32_client: Optional[AblyRealtime] = None
        self.dashboard_client: Optional[AblyRealtime] = None
        self.supabase_client: Optional[Client] = None
        self.esp32_channel = None
        self.dashboard_channel = None

        self.running = False
        self.shutdown_event = asyncio.Event()

        # Use bounded queue to prevent memory issues
        self.message_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=MAX_QUEUE_SIZE)
        self.db_buffer: List[Dict[str, Any]] = []
        self.db_buffer_lock = threading.Lock()

        self.db_retry_queue: List[List[Dict[str, Any]]] = []
        self.db_retry_backoff = RETRY_BASE_BACKOFF
        self.db_write_failures = 0

        self.session_id = str(uuid.uuid4())
        self.session_start_time = datetime.now(timezone.utc)

        if session_name and session_name.strip():
            self.session_name = session_name.strip()
        else:
            self.session_name = f"Session {self.session_id[:8]}"

        self.journal = LocalJournal(SPOOL_DIR, self.session_id)

        # Connection health tracking
        self.esp32_health = ConnectionHealth()
        self.dashboard_health = ConnectionHealth()
        self._reconnect_lock = asyncio.Lock()

        # Rate-limited publisher for controlled Ably message delivery
        self.rate_limited_publisher = RateLimitedPublisher()

        # Outlier detection engine
        self.outlier_detector = OutlierDetector()

        self.stats = {
            "messages_received": 0,
            "messages_republished": 0,
            "messages_stored_db": 0,
            "messages_dropped": 0,
            "last_message_time": None,
            "last_db_write_time": None,
            "errors": 0,
            "last_error": None,
            "current_session_id": self.session_id,
            "current_session_name": self.session_name,
            "session_start_time": self.session_start_time.isoformat(),
            "mock_scenario": self.mock_config.scenario.value if mock_mode else None,
            "reconnect_count": 0,
            # Rate limiter stats
            "queue_depth": 0,
            "burst_events": 0,
            "max_queue_depth_reached": 0,
            "messages_delayed": 0,
            # Outlier stats
            "outliers_detected": 0,
            "outlier_detection_avg_ms": 0.0,
        }

        # ESP32 binary format
        self.BINARY_FORMAT = "<ffffffI"
        self.BINARY_FIELD_NAMES = [
            "speed_ms",
            "voltage_v",
            "current_a",
            "latitude",
            "longitude",
            "altitude",
            "message_id",
        ]
        self.BINARY_MESSAGE_SIZE = struct.calcsize(self.BINARY_FORMAT)

        # Mock sim state
        self.cumulative_distance = 0.0
        self.cumulative_energy = 0.0
        self.simulation_time = 0
        self.prev_speed = 0.0
        self.message_count = 0
        self.base_altitude = 100.0
        self.base_lat = 40.7128
        self.base_lon = -74.0060
        
        # Mock error simulation state
        self._sensor_failure_remaining = 0
        self._current_failed_sensors: List[str] = []
        self._gps_drift_offset = (0.0, 0.0)

        # Signals
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

        logger.info(f"🆔 New session: {self.session_id}")
        logger.info(f"📝 Session name: {self.session_name}")
        if self.mock_mode:
            logger.info(f"🎭 MOCK MODE: {self.mock_config.scenario.value.upper()}")
        else:
            logger.info("🔗 REAL MODE ENABLED")

    def _signal_handler(self, signum, frame):
        logger.info(f"Received signal {signum}, initiating shutdown...")
        self.running = False
        try:
            loop = asyncio.get_event_loop()
            loop.call_soon_threadsafe(self.shutdown_event.set)
        except Exception:
            pass

    # ------------- Connections with reliability -------------

    async def connect_supabase(self) -> bool:
        try:
            self.supabase_client = create_client(SUPABASE_URL, SUPABASE_API_KEY)
            logger.info("✅ Connected to Supabase")
            return True
        except Exception as e:
            self._count_error(f"Supabase connect failed: {e}")
            return False

    async def connect_esp32_subscriber(self) -> bool:
        if self.mock_mode:
            return True
        try:
            self.esp32_client = AblyRealtime(ESP32_ABLY_API_KEY)
            await self._wait_for_connection(self.esp32_client, "ESP32", CONNECTION_TIMEOUT)
            self.esp32_channel = self.esp32_client.channels.get(ESP32_CHANNEL_NAME)
            await self.esp32_channel.subscribe(self._on_esp32_message_received)
            self.esp32_health.is_connected = True
            self.esp32_health.reconnect_attempts = 0
            logger.info(f"✅ Subscribed to ESP32 channel: {ESP32_CHANNEL_NAME}")
            return True
        except Exception as e:
            self._count_error(f"ESP32 connect failed: {e}")
            self.esp32_health.record_error()
            return False

    async def connect_dashboard_publisher(self) -> bool:
        try:
            self.dashboard_client = AblyRealtime(DASHBOARD_ABLY_API_KEY)
            await self._wait_for_connection(self.dashboard_client, "Dashboard", CONNECTION_TIMEOUT)
            self.dashboard_channel = self.dashboard_client.channels.get(
                DASHBOARD_CHANNEL_NAME
            )
            self.dashboard_health.is_connected = True
            self.dashboard_health.reconnect_attempts = 0
            logger.info(f"✅ Connected to dashboard channel: {DASHBOARD_CHANNEL_NAME}")
            return True
        except Exception as e:
            self._count_error(f"Dashboard connect failed: {e}")
            self.dashboard_health.record_error()
            return False

    async def _wait_for_connection(self, client, name: str, timeout: float = 10):
        logger.info(f"Waiting for {name} connection...")
        start = time.time()
        while time.time() - start < timeout:
            if client.connection.state == "connected":
                logger.info(f"✅ {name} connected")
                return
            if client.connection.state in ("failed", "closed", "suspended"):
                raise ConnectionError(f"{name} connection state: {client.connection.state}")
            await asyncio.sleep(0.1)
        raise TimeoutError(f"{name} connection timeout after {timeout}s")

    async def _reconnect_esp32(self) -> bool:
        """Attempt to reconnect to ESP32 with exponential backoff"""
        async with self._reconnect_lock:
            if self.esp32_health.reconnect_attempts >= RECONNECT_MAX_ATTEMPTS:
                logger.error(f"❌ ESP32 max reconnect attempts ({RECONNECT_MAX_ATTEMPTS}) reached")
                return False
            
            self.esp32_health.reset_for_reconnect()
            delay = min(
                RECONNECT_BASE_DELAY * (2 ** self.esp32_health.reconnect_attempts),
                RETRY_BACKOFF_MAX
            )
            
            logger.warning(f"🔄 Reconnecting to ESP32 (attempt {self.esp32_health.reconnect_attempts}) in {delay:.1f}s...")
            await asyncio.sleep(delay)
            
            try:
                if self.esp32_client:
                    try:
                        await self.esp32_client.close()
                    except Exception:
                        pass
                
                self.esp32_client = AblyRealtime(ESP32_ABLY_API_KEY)
                await self._wait_for_connection(self.esp32_client, "ESP32", CONNECTION_TIMEOUT)
                self.esp32_channel = self.esp32_client.channels.get(ESP32_CHANNEL_NAME)
                await self.esp32_channel.subscribe(self._on_esp32_message_received)
                
                self.esp32_health.is_connected = True
                self.esp32_health.reconnect_attempts = 0
                self.stats["reconnect_count"] += 1
                logger.info("✅ ESP32 reconnected successfully")
                return True
                
            except Exception as e:
                self._count_error(f"ESP32 reconnect failed: {e}")
                self.esp32_health.record_error()
                return False

    async def _reconnect_dashboard(self) -> bool:
        """Attempt to reconnect to dashboard with exponential backoff"""
        async with self._reconnect_lock:
            if self.dashboard_health.reconnect_attempts >= RECONNECT_MAX_ATTEMPTS:
                logger.error(f"❌ Dashboard max reconnect attempts ({RECONNECT_MAX_ATTEMPTS}) reached")
                return False
            
            self.dashboard_health.reset_for_reconnect()
            delay = min(
                RECONNECT_BASE_DELAY * (2 ** self.dashboard_health.reconnect_attempts),
                RETRY_BACKOFF_MAX
            )
            
            logger.warning(f"🔄 Reconnecting to Dashboard (attempt {self.dashboard_health.reconnect_attempts}) in {delay:.1f}s...")
            await asyncio.sleep(delay)
            
            try:
                if self.dashboard_client:
                    try:
                        await self.dashboard_client.close()
                    except Exception:
                        pass
                
                self.dashboard_client = AblyRealtime(DASHBOARD_ABLY_API_KEY)
                await self._wait_for_connection(self.dashboard_client, "Dashboard", CONNECTION_TIMEOUT)
                self.dashboard_channel = self.dashboard_client.channels.get(DASHBOARD_CHANNEL_NAME)
                
                self.dashboard_health.is_connected = True
                self.dashboard_health.reconnect_attempts = 0
                self.stats["reconnect_count"] += 1
                logger.info("✅ Dashboard reconnected successfully")
                return True
                
            except Exception as e:
                self._count_error(f"Dashboard reconnect failed: {e}")
                self.dashboard_health.record_error()
                return False

    # ------------- Mock generation with error simulation -------------

    def _apply_sensor_failures(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Apply sensor failure simulation"""
        cfg = self.mock_config
        
        # Check if we should start new sensor failures
        if self._sensor_failure_remaining <= 0:
            if random.random() < cfg.sensor_failure_probability:
                # Start a new failure period
                self._sensor_failure_remaining = cfg.sensor_failure_duration
                # Pick random sensors to fail
                all_sensors = ["voltage_v", "current_a", "gyro_x", "gyro_y", "gyro_z", 
                              "accel_x", "accel_y", "accel_z"]
                fail_count = random.randint(1, 4)
                self._current_failed_sensors = random.sample(all_sensors, fail_count)
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
        cfg = self.mock_config
        
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
            logger.warning(f"⚠️ SIMULATION: GPS position jump ({jump_lat:.4f}, {jump_lon:.4f})")
        
        return data

    def _should_stall(self) -> bool:
        """Check if we should stall data generation"""
        cfg = self.mock_config
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
            logger.warning(f"⚠️ SIMULATION: Data stall started ({duration:.1f}s)")
            return True
        
        return False

    def _should_drop_message(self) -> bool:
        """Check if we should drop this message (intermittent simulation)"""
        cfg = self.mock_config
        
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

    def generate_mock_telemetry_data(self) -> Optional[Dict[str, Any]]:
        """Generate mock telemetry data with optional error simulation"""
        
        # Check for data stall
        if self._should_stall():
            return None
        
        # Check for message drop
        if self._should_drop_message():
            self.stats["messages_dropped"] += 1
            return None
        
        now = datetime.now(timezone.utc)

        base_speed = 15.0 + 5.0 * math.sin(self.simulation_time * 0.1)
        speed_variation = random.gauss(0, 1.4)
        speed = max(0, min(25, base_speed + speed_variation))

        voltage = max(40, min(55, 48.0 + random.gauss(0, 1.4)))
        current = max(0, min(15, 7.5 + speed * 0.2 + random.gauss(0, 0.9)))
        power = voltage * current

        energy_delta = power * MOCK_DATA_INTERVAL
        distance_delta = speed * MOCK_DATA_INTERVAL
        self.cumulative_energy += energy_delta
        self.cumulative_distance += distance_delta

        lat_offset = 0.001 * math.sin(self.simulation_time * 0.05)
        lon_offset = 0.001 * math.cos(self.simulation_time * 0.05)
        latitude = self.base_lat + lat_offset + random.gauss(0, 0.0001)
        longitude = self.base_lon + lon_offset + random.gauss(0, 0.0001)

        altitude_variation = 10.0 * math.sin(self.simulation_time * 0.03)
        altitude = self.base_altitude + altitude_variation + random.gauss(0, 1.0)

        turning_rate = 2.0 * math.sin(self.simulation_time * 0.08)
        gyro_x = random.gauss(0, 0.5)
        gyro_y = random.gauss(0, 0.3)
        gyro_z = turning_rate + random.gauss(0, 0.8)

        speed_acc = (speed - self.prev_speed) / MOCK_DATA_INTERVAL
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
            "uptime_seconds": self.simulation_time * MOCK_DATA_INTERVAL,
            "data_source": f"MOCK_{self.mock_config.scenario.value.upper()}",
            "session_id": self.session_id,
            "session_name": self.session_name,
            "throttle_pct": round(throttle_pct, 1),
            "brake_pct": round(brake_pct, 1),
            "throttle": round(throttle_pct / 100.0, 3),
            "brake": round(brake_pct / 100.0, 3),
        }

        # Apply error simulations
        if self.mock_config.scenario in (MockScenario.SENSOR_FAILURES, MockScenario.CHAOS):
            data = self._apply_sensor_failures(data)
        
        if self.mock_config.scenario in (MockScenario.GPS_ISSUES, MockScenario.CHAOS):
            data = self._apply_gps_issues(data)

        return data

    # ------------- Parsers -------------

    def _parse_json_message(self, b: bytes) -> Optional[Dict]:
        try:
            s = b.decode("utf-8") if isinstance(b, (bytes, bytearray)) else str(b)
            return json.loads(s)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _parse_binary_message(self, b: bytes) -> Optional[Dict]:
        if not isinstance(b, (bytes, bytearray)) or len(b) != self.BINARY_MESSAGE_SIZE:
            return None
        try:
            vals = struct.unpack(self.BINARY_FORMAT, b)
            d = dict(zip(self.BINARY_FIELD_NAMES, vals))
            d["power_w"] = d["voltage_v"] * d["current_a"]
            return d
        except struct.error:
            return None

    def _validate_message(self, data: Dict[str, Any]) -> bool:
        """Validate that message has minimum required fields and sane values"""
        if not isinstance(data, dict):
            return False
        
        # Check for at least some core fields
        core_fields = ["speed_ms", "voltage_v", "current_a"]
        has_core = any(field in data for field in core_fields)
        
        if not has_core:
            return False
        
        # Sanity check numeric values (prevent NaN/Inf)
        for key, val in data.items():
            if isinstance(val, float):
                if math.isnan(val) or math.isinf(val):
                    logger.warning(f"⚠️ Invalid value for {key}: {val}")
                    data[key] = 0.0
        
        return True

    # ------------- Normalization -------------

    def _normalize_telemetry_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        out = data.copy()
        out["session_id"] = self.session_id
        out["session_name"] = self.session_name

        # timestamp
        if "timestamp" not in out or str(out["timestamp"]).startswith("1970-01-01"):
            out["timestamp"] = datetime.now(timezone.utc).isoformat()
        if isinstance(out["timestamp"], str):
            try:
                dt = datetime.fromisoformat(out["timestamp"].replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                out["timestamp"] = dt.isoformat()
            except Exception:
                out["timestamp"] = datetime.now(timezone.utc).isoformat()

        # defaults
        defaults = {
            "speed_ms": 0.0,
            "voltage_v": 0.0,
            "current_a": 0.0,
            "power_w": 0.0,
            "energy_j": 0.0,
            "distance_m": 0.0,
            "latitude": 0.0,
            "longitude": 0.0,
            "altitude": 0.0,
            "gyro_x": 0.0,
            "gyro_y": 0.0,
            "gyro_z": 0.0,
            "accel_x": 0.0,
            "accel_y": 0.0,
            "accel_z": 0.0,
            "total_acceleration": 0.0,
            "message_id": 0,
            "uptime_seconds": 0.0,
            "throttle_pct": 0.0,
            "brake_pct": 0.0,
            "throttle": 0.0,
            "brake": 0.0,
            "data_source": "ESP32_REAL" if not self.mock_mode else "MOCK_GENERATOR",
        }
        for k, v in defaults.items():
            out.setdefault(k, v)

        if not out.get("power_w"):
            out["power_w"] = out.get("voltage_v", 0.0) * out.get("current_a", 0.0)

        if not out.get("total_acceleration"):
            out["total_acceleration"] = math.sqrt(
                out.get("accel_x", 0.0) ** 2
                + out.get("accel_y", 0.0) ** 2
                + out.get("accel_z", 0.0) ** 2
            )

        # sync driver inputs between % and 0..1
        def _clamp01(v: float) -> float:
            try:
                return max(0.0, min(1.0, float(v)))
            except Exception:
                return 0.0

        if out.get("throttle_pct", 0) == 0 and out.get("throttle", 0) != 0:
            out["throttle_pct"] = round(_clamp01(out["throttle"]) * 100.0, 2)
        if out.get("brake_pct", 0) == 0 and out.get("brake", 0) != 0:
            out["brake_pct"] = round(_clamp01(out["brake"]) * 100.0, 2)
        if out.get("throttle", 0) == 0 and out.get("throttle_pct", 0) != 0:
            out["throttle"] = round(_clamp01(out["throttle_pct"] / 100.0), 3)
        if out.get("brake", 0) == 0 and out.get("brake_pct", 0) != 0:
            out["brake"] = round(_clamp01(out["brake_pct"] / 100.0), 3)

        # Run outlier detection (target: <5ms)
        outlier_info = self.outlier_detector.detect(out)
        if outlier_info:
            out["outliers"] = outlier_info
            self.stats["outliers_detected"] += 1
        else:
            out["outliers"] = None  # Explicit null for no outliers

        # Update outlier detection latency stat
        self.stats["outlier_detection_avg_ms"] = round(
            self.outlier_detector.get_avg_latency_ms(), 3
        )

        return out

    # ------------- ESP32 handler -------------

    def _on_esp32_message_received(self, message):
        try:
            data = None
            if isinstance(message.data, (bytes, bytearray)):
                data = self._parse_json_message(message.data) or self._parse_binary_message(
                    message.data
                )
            elif isinstance(message.data, str):
                try:
                    data = json.loads(message.data)
                except json.JSONDecodeError:
                    data = None
            elif isinstance(message.data, dict):
                data = message.data

            if data is None:
                self._count_error("Failed to parse incoming ESP32 message")
                return
            
            # Validate message
            if not self._validate_message(data):
                self._count_error("Message validation failed")
                return

            normalized = self._normalize_telemetry_data(data)

            # 1) durable journal
            self.journal.append(normalized)

            # 2) realtime + db buffer (with backpressure)
            try:
                self.message_queue.put_nowait(normalized)
            except queue.Full:
                # Drop oldest messages if queue is full
                try:
                    self.message_queue.get_nowait()
                    self.message_queue.put_nowait(normalized)
                    self.stats["messages_dropped"] += 1
                except queue.Empty:
                    pass
            
            with self.db_buffer_lock:
                self.db_buffer.append(normalized)

            self.stats["messages_received"] += 1
            self.stats["last_message_time"] = datetime.now(timezone.utc)
            self.esp32_health.record_message()

        except Exception as e:
            self._count_error(f"ESP32 handler error: {e}")
            self.esp32_health.record_error()

    # ------------- Mock loop -------------

    async def generate_mock_data_loop(self):
        if not self.mock_mode:
            return
        while self.running and not self.shutdown_event.is_set():
            try:
                mock = self.generate_mock_telemetry_data()
                
                if mock is None:
                    # Stall or drop simulation - just wait
                    await asyncio.sleep(MOCK_DATA_INTERVAL)
                    continue
                
                self.journal.append(mock)
                
                try:
                    self.message_queue.put_nowait(mock)
                except queue.Full:
                    try:
                        self.message_queue.get_nowait()
                        self.message_queue.put_nowait(mock)
                        self.stats["messages_dropped"] += 1
                    except queue.Empty:
                        pass
                
                with self.db_buffer_lock:
                    self.db_buffer.append(mock)
                
                self.stats["messages_received"] += 1
                self.stats["last_message_time"] = datetime.now(timezone.utc)
                await asyncio.sleep(MOCK_DATA_INTERVAL)
            except Exception as e:
                self._count_error(f"Mock loop error: {e}")

    # ------------- Republish with reconnection -------------

    async def republish_messages(self):
        """Republish messages with rate limiting to prevent Ably limits"""
        # Initialize rate limiter async components
        await self.rate_limited_publisher.initialize()

        while self.running and not self.shutdown_event.is_set():
            try:
                # Check connection health
                if not self.dashboard_health.is_connected:
                    self.rate_limited_publisher.set_connected(False)
                    await self._reconnect_dashboard()
                    if not self.dashboard_health.is_connected:
                        await asyncio.sleep(1)
                        continue
                    else:
                        self.rate_limited_publisher.set_connected(True)
                        # Drain any queued messages from disconnection period
                        if self.rate_limited_publisher._queue and not self.rate_limited_publisher._queue.empty():
                            logger.info(f"🔄 Draining {self.rate_limited_publisher._queue.qsize()} queued messages...")
                            await self.rate_limited_publisher.drain_queue(self.dashboard_channel)

                # Get messages from the incoming queue
                batch = []
                while not self.message_queue.empty() and len(batch) < 20:
                    try:
                        batch.append(self.message_queue.get_nowait())
                    except queue.Empty:
                        break

                # Publish each message through rate limiter
                for m in batch:
                    try:
                        published = await self.rate_limited_publisher.publish_immediately(
                            self.dashboard_channel, m
                        )
                        if published:
                            self.stats["messages_republished"] += 1
                            self.dashboard_health.record_message()
                    except Exception as e:
                        self._count_error(f"Republish failed: {e}")
                        self.dashboard_health.record_error()
                        self.dashboard_health.is_connected = False
                        # Re-queue message for retry
                        await self.rate_limited_publisher.enqueue(m)
                        break

                # Update rate limiter stats
                rl_stats = self.rate_limited_publisher.get_stats()
                self.stats["queue_depth"] = rl_stats["queue_depth"]
                self.stats["burst_events"] = rl_stats["burst_events"]
                self.stats["max_queue_depth_reached"] = rl_stats["max_queue_depth_reached"]
                self.stats["messages_delayed"] = rl_stats["messages_delayed"]

                # Periodically drain the rate limiter queue
                if self.rate_limited_publisher._queue and not self.rate_limited_publisher._queue.empty():
                    await self.rate_limited_publisher.drain_queue(self.dashboard_channel)

                await asyncio.sleep(0.05)
            except Exception as e:
                self._count_error(f"Republish loop error: {e}")

    # ------------- Health check / watchdog -------------

    async def health_monitor(self):
        """Monitor connection health and trigger reconnects"""
        while self.running and not self.shutdown_event.is_set():
            try:
                await asyncio.sleep(HEALTH_CHECK_INTERVAL)
                
                # Check ESP32 connection (real mode only)
                if not self.mock_mode:
                    if self.esp32_health.is_stale(WATCHDOG_TIMEOUT):
                        logger.warning(f"⚠️ ESP32 data stale for {WATCHDOG_TIMEOUT}s - triggering reconnect")
                        self.esp32_health.is_connected = False
                        await self._reconnect_esp32()
                    
                    # Check Ably connection state
                    if self.esp32_client and self.esp32_client.connection.state != "connected":
                        logger.warning(f"⚠️ ESP32 Ably state: {self.esp32_client.connection.state}")
                        self.esp32_health.is_connected = False
                
                # Check dashboard connection
                if self.dashboard_client and self.dashboard_client.connection.state != "connected":
                    logger.warning(f"⚠️ Dashboard Ably state: {self.dashboard_client.connection.state}")
                    self.dashboard_health.is_connected = False
                
            except Exception as e:
                self._count_error(f"Health monitor error: {e}")

    # ------------- DB writer & retry -------------

    async def database_batch_writer(self):
        next_retry_at = time.monotonic()
        while self.running and not self.shutdown_event.is_set():
            try:
                await asyncio.sleep(DB_BATCH_INTERVAL)

                # Retry failed batches if it's time
                now_mono = time.monotonic()
                if self.db_retry_queue and now_mono >= next_retry_at:
                    retry_batches = list(self.db_retry_queue)
                    self.db_retry_queue.clear()
                    ok = await self._write_batches_to_database(retry_batches)
                    if not ok:
                        self.db_retry_backoff = min(
                            RETRY_BACKOFF_MAX, self.db_retry_backoff * 2
                        )
                    else:
                        self.db_retry_backoff = RETRY_BASE_BACKOFF
                    next_retry_at = time.monotonic() + self.db_retry_backoff

                # Flush new buffer
                with self.db_buffer_lock:
                    buffer_copy = list(self.db_buffer)
                    self.db_buffer.clear()
                if buffer_copy:
                    chunks = [
                        buffer_copy[i : i + MAX_BATCH_SIZE]
                        for i in range(0, len(buffer_copy), MAX_BATCH_SIZE)
                    ]
                    ok = await self._write_batches_to_database(chunks)
                    if not ok:
                        next_retry_at = time.monotonic() + self.db_retry_backoff

            except Exception as e:
                self._count_error(f"DB writer loop error: {e}")

    async def _write_batches_to_database(
        self, batches: List[List[Dict[str, Any]]]
    ) -> bool:
        if not self.supabase_client:
            self.db_retry_queue.extend(batches)
            self.db_write_failures += len(batches)
            return False

        all_ok = True
        for batch in batches:
            try:
                rows = []
                for r in batch:
                    rows.append(
                        {
                            "session_id": r["session_id"],
                            "session_name": r.get("session_name", self.session_name),
                            "timestamp": r["timestamp"],
                            "speed_ms": r.get("speed_ms"),
                            "voltage_v": r.get("voltage_v"),
                            "current_a": r.get("current_a"),
                            "power_w": r.get("power_w"),
                            "energy_j": r.get("energy_j"),
                            "distance_m": r.get("distance_m"),
                            "latitude": r.get("latitude"),
                            "longitude": r.get("longitude"),
                            "altitude_m": r.get("altitude"),
                            "gyro_x": r.get("gyro_x"),
                            "gyro_y": r.get("gyro_y"),
                            "gyro_z": r.get("gyro_z"),
                            "accel_x": r.get("accel_x"),
                            "accel_y": r.get("accel_y"),
                            "accel_z": r.get("accel_z"),
                            "total_acceleration": r.get("total_acceleration"),
                            "message_id": r.get("message_id"),
                            "uptime_seconds": r.get("uptime_seconds"),
                            "throttle_pct": r.get("throttle_pct"),
                            "brake_pct": r.get("brake_pct"),
                            "throttle": r.get("throttle"),
                            "brake": r.get("brake"),
                            "data_source": r.get("data_source"),
                        }
                    )

                resp = (
                    self.supabase_client.table(SUPABASE_TABLE_NAME)
                    .insert(rows)
                    .execute()
                )
                if not resp.data:
                    raise RuntimeError("Supabase insert returned no data")

                self.stats["messages_stored_db"] += len(resp.data)
                self.stats["last_db_write_time"] = datetime.now(timezone.utc)

            except Exception as e:
                all_ok = False
                self.db_write_failures += 1
                self._count_error(f"DB write failed (batch {len(batch)}): {e}")
                self.db_retry_queue.append(batch)

        return all_ok

    # ------------- Stats -------------

    async def print_stats(self):
        while self.running and not self.shutdown_event.is_set():
            try:
                await asyncio.sleep(30)
                mode = f"MOCK/{self.mock_config.scenario.value}" if self.mock_mode else "REAL"
                buf_len = len(self.db_buffer)
                retry_batches = len(self.db_retry_queue)
                dropped = self.stats.get("messages_dropped", 0)
                reconnects = self.stats.get("reconnect_count", 0)
                queue_depth = self.stats.get("queue_depth", 0)
                burst_events = self.stats.get("burst_events", 0)
                outliers = self.stats.get("outliers_detected", 0)
                outlier_latency = self.stats.get("outlier_detection_avg_ms", 0)
                
                logger.info(
                    f"📊 STATS ({mode}) - "
                    f"Received: {self.stats['messages_received']}, "
                    f"Republished: {self.stats['messages_republished']}, "
                    f"DB Stored: {self.stats['messages_stored_db']}, "
                    f"Dropped: {dropped}, "
                    f"Buffer: {buf_len}, RetryBatches: {retry_batches}, "
                    f"Reconnects: {reconnects}, "
                    f"Errors: {self.stats['errors']}"
                )
                logger.info(
                    f"   📈 RateLimiter: QueueDepth={queue_depth}, Bursts={burst_events} | "
                    f"Outliers: {outliers} detected, Latency: {outlier_latency:.2f}ms"
                )
                if self.stats["last_error"]:
                    logger.info(f"🔍 Last Error: {self.stats['last_error']}")
            except Exception as e:
                self._count_error(f"Stats loop error: {e}")

    # ------------- Lifecycle -------------

    async def run(self):
        try:
            ok_db = await self.connect_supabase()
            ok_src = await self.connect_esp32_subscriber()
            ok_out = await self.connect_dashboard_publisher()
            if not ok_out or (not ok_src and not self.mock_mode):
                logger.error("❌ Required connections failed. Exiting.")
                return

            self.running = True
            logger.info(
                f"🚀 Bridge started (Session: {self.session_name} / {self.session_id[:8]})"
            )
            if self.mock_mode:
                logger.info(f"🎭 Simulation scenario: {self.mock_config.scenario.value}")

            tasks: List[asyncio.Task] = [
                asyncio.create_task(self.republish_messages(), name="republish"),
                asyncio.create_task(
                    self.database_batch_writer(), name="db_writer"
                ),
                asyncio.create_task(self.print_stats(), name="stats"),
                asyncio.create_task(self.health_monitor(), name="health"),
            ]
            if self.mock_mode:
                tasks.append(
                    asyncio.create_task(
                        self.generate_mock_data_loop(), name="mock_loop"
                    )
                )

            shutdown_wait = asyncio.create_task(
                self.shutdown_event.wait(), name="shutdown_wait"
            )

            done, pending = await asyncio.wait(
                tasks + [shutdown_wait],
                return_when=asyncio.FIRST_COMPLETED,
            )

            # If shutdown_wait fired, stop loops
            self.running = False

            # Cancel any pending tasks gracefully
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

        except Exception as e:
            self._count_error(f"Run error: {e}")
        finally:
            await self.cleanup()

    async def cleanup(self):
        try:
            logger.info("🧹 Cleaning up ...")

            # Flush leftover db_buffer
            with self.db_buffer_lock:
                pending = list(self.db_buffer)
                self.db_buffer.clear()
            if pending:
                chunks = [
                    pending[i : i + MAX_BATCH_SIZE]
                    for i in range(0, len(pending), MAX_BATCH_SIZE)
                ]
                logger.info(f"💾 Flushing final DB buffer ({len(pending)})")
                await self._write_batches_to_database(chunks)

            # If failures or pending retries, export full CSV for the session
            if self.db_write_failures > 0 or self.db_retry_queue:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                out_csv = os.path.join(
                    EXPORT_DIR, f"telemetry_{self.session_id}_{ts}.csv"
                )
                field_order = [
                    "session_id",
                    "session_name",
                    "timestamp",
                    "speed_ms",
                    "voltage_v",
                    "current_a",
                    "power_w",
                    "energy_j",
                    "distance_m",
                    "latitude",
                    "longitude",
                    "altitude",
                    "gyro_x",
                    "gyro_y",
                    "gyro_z",
                    "accel_x",
                    "accel_y",
                    "accel_z",
                    "total_acceleration",
                    "message_id",
                    "uptime_seconds",
                    "throttle_pct",
                    "brake_pct",
                    "throttle",
                    "brake",
                    "data_source",
                ]
                n = self.journal.export_csv(out_csv, field_order)
                logger.warning(
                    f"📤 Exported session CSV with {n} rows to {out_csv} "
                    f"(DB failures or pending retries)"
                )

            # Close Ably
            if self.esp32_client:
                try:
                    await self.esp32_client.close()
                except Exception:
                    pass
            if self.dashboard_client:
                try:
                    await self.dashboard_client.close()
                except Exception:
                    pass

            # Close journal
            self.journal.close()

            logger.info("✅ Cleanup done")
        except Exception as e:
            self._count_error(f"Cleanup error: {e}")

    # ------------- Helpers -------------

    def _count_error(self, msg: str):
        logger.error(f"❌ {msg}")
        self.stats["errors"] += 1
        self.stats["last_error"] = msg


# ------------------------------
# CLI
# ------------------------------

def get_user_preferences() -> tuple:
    print("\n" + "=" * 70)
    print("🚀 TELEMETRY BRIDGE WITH DATABASE")
    print("=" * 70)
    print("1. 🔗 REAL DATA (ESP32)")
    print("2. 🎭 MOCK DATA (simulated)")
    while True:
        choice = input("Enter your choice (1 or 2): ").strip()
        if choice == "1":
            mock_mode = False
            print("✅ Selected REAL DATA\n")
            break
        if choice == "2":
            mock_mode = True
            print("✅ Selected MOCK DATA\n")
            break
        print("❌ Invalid choice.")

    mock_config = MockModeConfig()
    
    if mock_mode:
        print("-" * 50)
        print("📊 MOCK SIMULATION SCENARIOS:")
        print("-" * 50)
        print("1. 🟢 NORMAL     - Realistic smooth simulation")
        print("2. ⚠️  SENSOR    - Simulate sensor failures/dropouts")
        print("3. ⏸️  STALLS    - Simulate data stream pauses")
        print("4. 📡 INTERMIT  - Simulate intermittent connection")
        print("5. 🛰️  GPS       - Simulate GPS signal issues")
        print("6. 💥 CHAOS     - All problems combined!")
        print("-" * 50)
        
        scenario_map = {
            "1": MockScenario.NORMAL,
            "2": MockScenario.SENSOR_FAILURES,
            "3": MockScenario.DATA_STALLS,
            "4": MockScenario.INTERMITTENT,
            "5": MockScenario.GPS_ISSUES,
            "6": MockScenario.CHAOS,
        }
        
        while True:
            scenario_choice = input("Select scenario (1-6) [default=1]: ").strip() or "1"
            if scenario_choice in scenario_map:
                mock_config = MockModeConfig.from_scenario(scenario_map[scenario_choice])
                print(f"✅ Selected: {mock_config.scenario.value.upper()}\n")
                break
            print("❌ Invalid choice. Enter 1-6.")

    session_name = input("Enter a session name (label): ").strip()
    if not session_name:
        scenario_tag = f"_{mock_config.scenario.value}" if mock_mode else ""
        session_name = f"{'M' if mock_mode else ''}Session{scenario_tag}_{str(uuid.uuid4())[:8]}"
    if mock_mode and not session_name.startswith("M "):
        session_name = "M " + session_name
    print(f"📝 Session name: {session_name}\n")
    
    return mock_mode, session_name, mock_config


async def main():
    try:
        mock_mode, session_name, mock_config = get_user_preferences()
        bridge = TelemetryBridgeWithDB(
            mock_mode=mock_mode, 
            session_name=session_name,
            mock_config=mock_config
        )
        await bridge.run()
    except KeyboardInterrupt:
        logger.info("🛑 Stopped by user")
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
    finally:
        logger.info("🏁 Exited")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("🛑 Interrupted")
    except Exception as e:
        logger.error(f"❌ Application error: {e}")