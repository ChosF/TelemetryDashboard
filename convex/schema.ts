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
    throttle: v.optional(v.number()),
    brake: v.optional(v.number()),
    data_source: v.optional(v.string()),
    outliers: v.optional(v.any()), // JSON object for outlier detection data
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
});
