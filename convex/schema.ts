import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  archivePartSummaryValidator,
  archiveStatsValidator,
} from "./archiveValidators";

export default defineSchema({
  // Custom Convex-native auth tables. Passwords use versioned, adaptive hashes;
  // session bearer tokens are never stored directly.
  authUsers: defineTable({
    email: v.string(),
    normalizedEmail: v.optional(v.string()),
    passwordHash: v.string(),
    name: v.optional(v.string()),
    passwordUpdatedAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_normalizedEmail", ["normalizedEmail"]),

  authSessions: defineTable({
    userId: v.id("authUsers"),
    // `token` is retained only so the schema can migrate existing rows. New
    // sessions set tokenHash and never persist the bearer token itself.
    token: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    persistent: v.optional(v.boolean()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_userId", ["userId"]),

  authRateLimits: defineTable({
    key: v.string(),
    attempts: v.number(),
    windowStartedAt: v.number(),
    blockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"]),

  authAuditLog: defineTable({
    event: v.union(
      v.literal("sign_up_succeeded"),
      v.literal("sign_up_rejected"),
      v.literal("sign_up_blocked"),
      v.literal("sign_in_succeeded"),
      v.literal("sign_in_failed"),
      v.literal("sign_in_blocked"),
      v.literal("sign_out"),
      v.literal("session_expired"),
      v.literal("role_changed"),
      v.literal("user_rejected"),
      v.literal("user_banned"),
      v.literal("user_deleted")
    ),
    userId: v.optional(v.id("authUsers")),
    emailHash: v.optional(v.string()),
    actorUserId: v.optional(v.id("authUsers")),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_userId_createdAt", ["userId", "createdAt"]),

  // Session metadata table — ONE document per session.
  // Maintained by insertTelemetryBatch so listSessions is O(sessions) not O(records).
  sessions: defineTable({
    session_id: v.string(),
    session_name: v.optional(v.string()),
    start_time: v.string(),   // ISO 8601 timestamp of first record
    end_time: v.string(),     // ISO 8601 timestamp of last record
    record_count: v.number(),
    // Inactive sessions are moved out of the document database and into
    // compressed, immutable file-storage parts. Only an active tail remains
    // in `telemetry` while a session is still receiving data.
    archive_status: v.optional(v.union(
      v.literal("pending"),
      v.literal("archiving"),
      v.literal("complete"),
      v.literal("error")
    )),
    archived_record_count: v.optional(v.number()),
    archive_part_count: v.optional(v.number()),
    archive_updated_at: v.optional(v.string()),
    archive_error: v.optional(v.string()),
    overview_storage_id: v.optional(v.id("_storage")),
    overview_point_count: v.optional(v.number()),
    archive_stats: v.optional(archiveStatsValidator),
  })
    .index("by_session_id", ["session_id"])
    .index("by_archive_status_end_time", ["archive_status", "end_time"])
    .index("by_archive_overview_end_time", ["archive_status", "overview_storage_id", "end_time"]),

  // Small database manifest for immutable telemetry blobs in file storage.
  // A session normally has only a few parts, so opening historical mode reads
  // metadata here instead of scanning thousands of wide telemetry documents.
  telemetryArchives: defineTable({
    session_id: v.string(),
    part_number: v.number(),
    storage_id: v.id("_storage"),
    preview_storage_id: v.optional(v.id("_storage")),
    record_count: v.number(),
    start_time: v.string(),
    end_time: v.string(),
    uncompressed_bytes: v.number(),
    compressed_bytes: v.number(),
    format: v.literal("json-gzip-v1"),
    summary: v.optional(archivePartSummaryValidator),
    created_at: v.string(),
  })
    .index("by_session_part", ["session_id", "part_number"]),

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
    // Steering-wheel-mounted IMU (same units as vehicle gyro/accel: °/s and m/s²)
    steering_gyro_x: v.optional(v.number()),
    steering_gyro_y: v.optional(v.number()),
    steering_gyro_z: v.optional(v.number()),
    steering_accel_x: v.optional(v.number()),
    steering_accel_y: v.optional(v.number()),
    steering_accel_z: v.optional(v.number()),
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
    // ESP32 efficiency values, resolved by the bridge with calculation fallbacks
    inst_eff_km_kwh: v.optional(v.number()),
    acc_eff_km_kwh: v.optional(v.number()),
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

  dashboardPreferences: defineTable({
    ownerId: v.id("authUsers"),
    theme: v.union(v.literal("circuit"), v.literal("technical-light")),
    defaultViewKey: v.optional(v.string()),
    lastViewKey: v.optional(v.string()),
    systemViewVersion: v.number(),
    legacyImportVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  dashboardViews: defineTable({
    ownerId: v.id("authUsers"),
    viewKey: v.string(),
    name: v.string(),
    kind: v.union(v.literal("system-override"), v.literal("custom")),
    systemViewId: v.optional(v.string()),
    position: v.number(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_key", ["ownerId", "viewKey"])
    .index("by_owner_position", ["ownerId", "position"]),

  dashboardWidgets: defineTable({
    ownerId: v.id("authUsers"),
    viewId: v.id("dashboardViews"),
    instanceId: v.string(),
    widgetType: v.string(),
    title: v.optional(v.string()),
    column: v.number(),
    row: v.number(),
    width: v.number(),
    height: v.number(),
    pinned: v.boolean(),
    config: v.object({
      metric: v.optional(v.string()),
      comparisonMetric: v.optional(v.string()),
      timeWindow: v.optional(v.union(
        v.literal("30s"),
        v.literal("60s"),
        v.literal("5m"),
        v.literal("15m"),
        v.literal("session"),
      )),
      chartStyle: v.optional(v.union(
        v.literal("line"),
        v.literal("area"),
        v.literal("scatter"),
        v.literal("bar"),
        v.literal("histogram"),
      )),
      series: v.optional(v.array(v.string())),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_view_row", ["viewId", "row"])
    .index("by_owner_view", ["ownerId", "viewId"])
    .index("by_view_instance", ["viewId", "instanceId"]),

  dashboardAlertAcknowledgements: defineTable({
    ownerId: v.id("authUsers"),
    eventKey: v.string(),
    sessionId: v.optional(v.string()),
    acknowledgedAt: v.number(),
  }).index("by_owner_event", ["ownerId", "eventKey"]),

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
