import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Custom auth tables (simple email/password auth)
  authUsers: defineTable({
    email: v.string(),
    passwordHash: v.string(),
    name: v.optional(v.string()),
  })
    .index("by_email", ["email"]),

  authSessions: defineTable({
    userId: v.id("authUsers"),
    token: v.string(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  // Session metadata table — ONE document per session.
  // Maintained by insertTelemetryBatch so listSessions is O(sessions) not O(records).
  sessions: defineTable({
    session_id: v.string(),
    session_name: v.optional(v.string()),
    start_time: v.string(),   // ISO 8601 timestamp of first record
    end_time: v.string(),     // ISO 8601 timestamp of last record
    record_count: v.number(),
  })
    .index("by_session_id", ["session_id"]),

  // Telemetry data table - stores all vehicle sensor data

  telemetry: defineTable({
    session_id: v.string(),
    session_name: v.optional(v.string()),
    timestamp: v.string(), // ISO 8601 timestamp
    speed_ms: v.optional(v.number()),
    voltage_v: v.optional(v.number()),
    current_a: v.optional(v.number()),
    power_w: v.optional(v.number()),
    energy_j: v.optional(v.number()),
    distance_m: v.optional(v.number()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    altitude_m: v.optional(v.number()),
    gyro_x: v.optional(v.number()),
    gyro_y: v.optional(v.number()),
    gyro_z: v.optional(v.number()),
    accel_x: v.optional(v.number()),
    accel_y: v.optional(v.number()),
    accel_z: v.optional(v.number()),
    total_acceleration: v.optional(v.number()),
    message_id: v.optional(v.number()),
    uptime_seconds: v.optional(v.number()),
    throttle_pct: v.optional(v.number()),
    brake_pct: v.optional(v.number()),
    brake2_pct: v.optional(v.number()),
    throttle: v.optional(v.number()),
    brake: v.optional(v.number()),
    brake2: v.optional(v.number()),
    motor_voltage_v: v.optional(v.number()),
    motor_current_a: v.optional(v.number()),
    motor_rpm: v.optional(v.number()),
    motor_phase_1_current_a: v.optional(v.number()),
    motor_phase_2_current_a: v.optional(v.number()),
    motor_phase_3_current_a: v.optional(v.number()),
    motor_phase_current_a: v.optional(v.number()),
    data_source: v.optional(v.string()),
    outliers: v.optional(v.any()), // JSON object for outlier detection data
    // Calculated fields from backend bridge
    current_efficiency_km_kwh: v.optional(v.number()),
    cumulative_energy_kwh: v.optional(v.number()),
    route_distance_km: v.optional(v.number()),
    avg_speed_kmh: v.optional(v.number()),
    max_speed_kmh: v.optional(v.number()),
    avg_power: v.optional(v.number()),
    avg_voltage: v.optional(v.number()),
    avg_current: v.optional(v.number()),
    max_power_w: v.optional(v.number()),
    max_current_a: v.optional(v.number()),
    // Optimal speed fields
    optimal_speed_kmh: v.optional(v.number()),
    optimal_speed_ms: v.optional(v.number()),
    optimal_efficiency_km_kwh: v.optional(v.number()),
    optimal_speed_confidence: v.optional(v.number()),
    optimal_speed_data_points: v.optional(v.number()),
    optimal_speed_range: v.optional(v.any()), // JSON object
    // Motion and driver state
    motion_state: v.optional(v.string()),
    driver_mode: v.optional(v.string()),
    throttle_intensity: v.optional(v.string()),
    brake_intensity: v.optional(v.string()),
    // G-force and acceleration stats
    current_g_force: v.optional(v.number()),
    max_g_force: v.optional(v.number()),
    accel_magnitude: v.optional(v.number()),
    avg_acceleration: v.optional(v.number()),
    // GPS derived
    elevation_gain_m: v.optional(v.number()),
    // Quality metrics
    quality_score: v.optional(v.number()),
    outlier_severity: v.optional(v.string()),
  })
    .index("by_session", ["session_id"])
    .index("by_session_timestamp", ["session_id", "timestamp"]),

  // User profiles table - extends auth users with app-specific data
  user_profiles: defineTable({
    userId: v.id("authUsers"), // Reference to our authUsers table
    email: v.string(),
    name: v.optional(v.string()),
    role: v.union(
      v.literal("guest"),
      v.literal("external"),
      v.literal("internal"),
      v.literal("admin")
    ),
    requested_role: v.optional(v.string()),
    approval_status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected")
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"])
    .index("by_approval_status", ["approval_status"]),

  // Driver notifications — driving recommendations, efficiency hints, optimal speed
  driver_notifications: defineTable({
    session_id: v.string(),
    severity: v.union(
      v.literal("info"),
      v.literal("warn"),
      v.literal("critical")
    ),
    title: v.string(),
    message: v.string(),
    category: v.optional(v.union(
      v.literal("efficiency"),
      v.literal("speed"),
      v.literal("style"),
      v.literal("system")
    )),
    ttl: v.optional(v.number()), // display duration in ms
    created_at: v.string(), // ISO 8601
  })
    .index("by_session", ["session_id"])
    .index("by_session_time", ["session_id", "created_at"]),
});
