---
description: ESP32 Telemetry Variables Guide - Complete reference for variable names and formats to send to maindata.py
---

# ESP32 Telemetry Variables Walkthrough Guide

This document provides a comprehensive guide on which variables the ESP32 microcontroller should send to the `maindata.py` backend bridge and the exact variable names to use.

---

## 📡 Communication Overview

| Setting | Value |
|---------|-------|
| **Protocol** | Ably Real-time |
| **API Key** | See `ESP32_ABLY_API_KEY` in `maindata.py` |
| **Channel Name** | `EcoTele` |
| **Data Format** | JSON |
| **Recommended Interval** | 200ms (5 Hz) |

---

## 🔌 Required Variables (Core Telemetry)

These variables are **essential** and should always be sent by the ESP32:

### Session & Timing

| Variable Name | Type | Unit | Description | Example |
|---------------|------|------|-------------|---------|
| `timestamp` | `string` | ISO 8601 | UTC timestamp of the reading | `"2026-02-04T19:06:52.123Z"` |
| `session_id` | `string` | - | Unique identifier for the telemetry session | `"esp32-session-2026-02-04"` |
| `session_name` | `string` | - | Human-readable session name | `"Track Day Run 1"` |
| `message_id` | `number` | count | Sequential message counter | `42` |
| `uptime_seconds` | `number` | seconds | ESP32 uptime since boot | `1234.5` |

---

### ⚡ Electrical System (CRITICAL)

These are the **most important** variables for efficiency calculations:

| Variable Name | Type | Unit | Valid Range | Description |
|---------------|------|------|-------------|-------------|
| `voltage_v` | `number` | Volts | 35.0 - 60.0 | Battery/system voltage |
| `current_a` | `number` | Amps | -10.0 - 35.0 | Current draw (negative = regen) |
| `power_w` | `number` | Watts | -500 - 2500 | Instantaneous power (`voltage_v * current_a`) |

> ⚠️ **Important**: These variables are flagged as `CRITICAL_FIELDS` in outlier detection. Ensure accuracy!

---

### 🚗 Speed & Motion

| Variable Name | Type | Unit | Valid Range | Description |
|---------------|------|------|-------------|-------------|
| `speed_ms` | `number` | m/s | 0 - 50 | Vehicle speed in meters per second |

> 💡 **Conversion**: To convert from km/h to m/s, divide by 3.6

---

### ⚡ Cumulative Metrics

| Variable Name | Type | Unit | Rules | Description |
|---------------|------|------|-------|-------------|
| `energy_j` | `number` | Joules | Must be monotonically increasing | Total energy consumed since session start |
| `distance_m` | `number` | Meters | Must be monotonically increasing | Total distance traveled since session start |

> ⚠️ These values should **never decrease** during a session. The backend will flag decreasing values as outliers.

---

### 📍 GPS / Location (All Optional)

| Variable Name | Type | Unit | Valid Range | Description |
|---------------|------|------|-------------|-------------|
| `latitude` | `number` | degrees | -90.0 to 90.0 | GPS latitude |
| `longitude` | `number` | degrees | -180.0 to 180.0 | GPS longitude |
| `altitude` | `number` | meters | -500 to 10000 | GPS altitude above sea level |

> 📌 The schema also accepts `altitude_m` as an alternative name for altitude.

---

### 🎛️ IMU / Motion Sensors

#### Gyroscope (Angular Velocity)

| Variable Name | Type | Unit | Max Rate | Description |
|---------------|------|------|----------|-------------|
| `gyro_x` | `number` | °/s | ±1000 | Roll rate |
| `gyro_y` | `number` | °/s | ±1000 | Pitch rate |
| `gyro_z` | `number` | °/s | ±1000 | Yaw rate (turning) |

#### Accelerometer (Linear Acceleration)

| Variable Name | Type | Unit | Max Magnitude | Description |
|---------------|------|------|---------------|-------------|
| `accel_x` | `number` | m/s² | 80 combined | Forward/backward acceleration |
| `accel_y` | `number` | m/s² | 80 combined | Left/right acceleration |
| `accel_z` | `number` | m/s² | 80 combined | Up/down (includes gravity ~9.81) |
| `total_acceleration` | `number` | m/s² | - | Pre-calculated: `√(x² + y² + z²)` |

> 💡 **G-Force Calculation**: The backend calculates G-force as `√(accel_x² + accel_y² + (accel_z - 9.81)²) / 9.81`

---

### 🎮 Driver Inputs (Optional but Recommended)

| Variable Name | Type | Unit | Range | Description |
|---------------|------|------|-------|-------------|
| `throttle_pct` | `number` | % | 0 - 100 | Throttle position percentage |
| `brake_pct` | `number` | % | 0 - 100 | Brake position percentage |
| `throttle` | `number` | ratio | 0.0 - 1.0 | Throttle as decimal (alternative) |
| `brake` | `number` | ratio | 0.0 - 1.0 | Brake as decimal (alternative) |

> 💡 You can send either `throttle_pct`/`brake_pct` OR `throttle`/`brake`. The `_pct` versions are preferred.

#### 🔧 Throttle Hardware Configuration (Current Implementation)

The ESP32 code is configured to read throttle from **GPIO 3** using ADC1_CHANNEL_3:

| Setting | Value |
|---------|-------|
| **GPIO Pin** | GPIO 3 (ADC1_CHANNEL_3) |
| **Min Voltage** | 0.83V = 0% throttle |
| **Max Voltage** | 3.33V = 100% throttle |
| **ADC Attenuation** | 11dB (0-3.9V range) |
| **Samples** | 100 samples averaged |

**Voltage-to-Percentage Formula:**
```
throttle_pct = (voltage - 0.83) / (3.33 - 0.83) × 100
```

> ⚠️ **Calibration**: If your throttle sensor has different min/max voltages, update the constants `THROTTLE_MIN_VOLTAGE` and `THROTTLE_MAX_VOLTAGE` in `adc_reader.h`

---

### 🏷️ Optional Metadata

| Variable Name | Type | Description |
|---------------|------|-------------|
| `data_source` | `string` | Identifier for data origin (e.g., `"ESP32_LIVE"`) |

---

## 📋 Complete JSON Example

Here's a complete example of a JSON payload the ESP32 should send:

```json
{
  "timestamp": "2026-02-04T19:06:52.123Z",
  "session_id": "esp32-track-day-20260204",
  "session_name": "Track Day Run 1",
  "message_id": 42,
  "uptime_seconds": 1234.5,
  
  "voltage_v": 48.2,
  "current_a": 12.5,
  "power_w": 602.5,
  
  "speed_ms": 8.3,
  
  "energy_j": 125000.0,
  "distance_m": 1520.5,
  
  "latitude": 40.7128,
  "longitude": -74.0060,
  "altitude": 105.2,
  
  "gyro_x": 0.15,
  "gyro_y": -0.08,
  "gyro_z": 2.35,
  
  "accel_x": 0.52,
  "accel_y": 0.18,
  "accel_z": 9.78,
  "total_acceleration": 9.81,
  
  "throttle_pct": 45.0,
  "brake_pct": 0.0,
  
  "data_source": "ESP32_LIVE"
}
```

---

## 🔄 Minimal JSON Example (Bare Minimum)

If you need to send minimal data:

```json
{
  "timestamp": "2026-02-04T19:06:52.123Z",
  "session_id": "my-session",
  "voltage_v": 48.2,
  "current_a": 12.5,
  "power_w": 602.5,
  "speed_ms": 8.3
}
```

> ⚠️ Missing optional fields will result in `null` values in the database and may affect calculated metrics.

---

## 📊 Calculated Fields (Backend)

The following fields are **automatically calculated** by `maindata.py` from the raw data you send. **DO NOT send these from ESP32**:

| Calculated Field | Source Variables | Description |
|------------------|------------------|-------------|
| `current_efficiency_km_kwh` | `speed_ms`, `power_w` | Rolling efficiency in km/kWh |
| `cumulative_energy_kwh` | `power_w` | Total energy in kWh |
| `route_distance_km` | `latitude`, `longitude` | GPS-based distance |
| `avg_speed_kmh` | `speed_ms` | Rolling average speed |
| `max_speed_kmh` | `speed_ms` | Session maximum speed |
| `avg_voltage` | `voltage_v` | Rolling average voltage |
| `avg_current` | `current_a` | Rolling average current |
| `avg_power` | `power_w` | Rolling average power |
| `max_power_w` | `power_w` | Session maximum power |
| `max_current_a` | `current_a` | Session maximum current |
| `optimal_speed_kmh` | `speed_ms`, `power_w` | Calculated optimal cruising speed |
| `optimal_speed_ms` | `speed_ms`, `power_w` | Optimal speed in m/s |
| `optimal_efficiency_km_kwh` | `speed_ms`, `power_w` | Efficiency at optimal speed |
| `optimal_speed_confidence` | - | Confidence in optimal speed calculation |
| `motion_state` | `speed_ms`, `accel_*`, `gyro_z` | Current motion: `stationary`, `cruising`, `accelerating`, `braking`, `turning` |
| `driver_mode` | `throttle_pct`, `brake_pct`, `speed_ms` | Driver style: `eco`, `normal`, `aggressive`, `coasting`, `braking` |
| `throttle_intensity` | `throttle_pct` | Classification: `idle`, `light`, `moderate`, `heavy` |
| `brake_intensity` | `brake_pct` | Classification: `idle`, `light`, `moderate`, `heavy` |
| `current_g_force` | `accel_x`, `accel_y`, `accel_z` | Current G-force |
| `max_g_force` | `accel_*` | Session maximum G-force |
| `accel_magnitude` | `accel_x`, `accel_y`, `accel_z` | Acceleration magnitude |
| `avg_acceleration` | `accel_*` | Rolling average acceleration |
| `elevation_gain_m` | `altitude` | Cumulative elevation gain |
| `quality_score` | All fields | Data quality assessment |
| `outliers` | All fields | Detected outliers (JSON object) |
| `outlier_severity` | All fields | Outlier severity level |

---

## 🚨 Outlier Detection Thresholds

The backend automatically flags values outside these ranges:

| Variable | Min | Max | Notes |
|----------|-----|-----|-------|
| `voltage_v` | 35.0 V | 60.0 V | Absolute bounds |
| `current_a` | -10.0 A | 35.0 A | Negative = regeneration |
| `power_w` | -500 W | 2500 W | |
| `speed_ms` | 0 m/s | 50 m/s | Negative values flagged |
| `altitude` | -500 m | 10000 m | |
| `latitude` | -90° | 90° | |
| `longitude` | -180° | 180° | |

### Dynamic Detection

| Check | Trigger | Threshold |
|-------|---------|-----------|
| Sudden voltage jump | Change > 50% of mean | Within window |
| Z-score outlier | > 5.0 standard deviations | Rolling window |
| Stuck sensor | Same value repeated | 15+ consecutive readings |
| GPS speed mismatch | GPS distance / reported speed | > 20:1 ratio |
| Impossible speed | GPS-derived speed | > 500 m/s |
| Altitude rate | Change between readings | > 50 m/interval |
| Speed acceleration | Speed change rate | > 50 m/s² |

---

## 📝 ESP32 Arduino Code Template

```cpp
#include <ArduinoJson.h>
#include <Ably.h>

// Ably channel for telemetry
const char* ABLY_CHANNEL = "EcoTele";

// Session info
String sessionId = "esp32-session-" + String(millis());
String sessionName = "ESP32 Session";
unsigned long messageCount = 0;

void sendTelemetry() {
  StaticJsonDocument<512> doc;
  
  // Session & Timing
  doc["timestamp"] = getISOTimestamp();  // Your timestamp function
  doc["session_id"] = sessionId;
  doc["session_name"] = sessionName;
  doc["message_id"] = ++messageCount;
  doc["uptime_seconds"] = millis() / 1000.0;
  
  // Electrical (REQUIRED)
  doc["voltage_v"] = readVoltage();       // Your voltage sensor
  doc["current_a"] = readCurrent();       // Your current sensor
  doc["power_w"] = doc["voltage_v"].as<float>() * doc["current_a"].as<float>();
  
  // Speed (REQUIRED)
  doc["speed_ms"] = readSpeed();          // Your speed sensor (m/s)
  
  // Cumulative (must be monotonically increasing)
  doc["energy_j"] = totalEnergyJoules;    // Running total
  doc["distance_m"] = totalDistanceMeters;// Running total
  
  // GPS (optional)
  if (gpsValid()) {
    doc["latitude"] = gps.lat();
    doc["longitude"] = gps.lng();
    doc["altitude"] = gps.alt();
  }
  
  // IMU (optional)
  doc["gyro_x"] = imu.gyroX();
  doc["gyro_y"] = imu.gyroY();
  doc["gyro_z"] = imu.gyroZ();
  doc["accel_x"] = imu.accelX();
  doc["accel_y"] = imu.accelY();
  doc["accel_z"] = imu.accelZ();
  
  // Driver inputs (optional)
  doc["throttle_pct"] = readThrottle() * 100.0;
  doc["brake_pct"] = readBrake() * 100.0;
  
  doc["data_source"] = "ESP32_LIVE";
  
  // Serialize and send
  String jsonString;
  serializeJson(doc, jsonString);
  
  // Send via Ably
  ablyChannel.publish("telemetry", jsonString);
}
```

---

## ✅ Variable Name Quick Reference

| Variable | Required | Type | Unit |
|----------|----------|------|------|
| `timestamp` | ✅ | string | ISO 8601 |
| `session_id` | ✅ | string | - |
| `session_name` | ⬜ | string | - |
| `message_id` | ⬜ | number | count |
| `uptime_seconds` | ⬜ | number | seconds |
| `voltage_v` | ✅ | number | V |
| `current_a` | ✅ | number | A |
| `power_w` | ✅ | number | W |
| `speed_ms` | ✅ | number | m/s |
| `energy_j` | ⬜ | number | J |
| `distance_m` | ⬜ | number | m |
| `latitude` | ⬜ | number | ° |
| `longitude` | ⬜ | number | ° |
| `altitude` | ⬜ | number | m |
| `gyro_x` | ⬜ | number | °/s |
| `gyro_y` | ⬜ | number | °/s |
| `gyro_z` | ⬜ | number | °/s |
| `accel_x` | ⬜ | number | m/s² |
| `accel_y` | ⬜ | number | m/s² |
| `accel_z` | ⬜ | number | m/s² |
| `total_acceleration` | ⬜ | number | m/s² |
| `throttle_pct` | ⬜ | number | % |
| `brake_pct` | ⬜ | number | % |
| `throttle` | ⬜ | number | ratio |
| `brake` | ⬜ | number | ratio |
| `data_source` | ⬜ | string | - |

**Legend:** ✅ = Required, ⬜ = Optional

---

## 📚 Additional Resources

- **maindata.py**: `TelemetryDashboard/backend/maindata.py`
- **Convex Schema**: `TelemetryDashboard/convex/schema.ts`
- **Ably Channel**: `EcoTele` (ESP32 → maindata.py bridge)
- **Dashboard Channel**: `telemetry-dashboard-channel` (maindata.py → Dashboard)

---

*Last Updated: February 4, 2026*
