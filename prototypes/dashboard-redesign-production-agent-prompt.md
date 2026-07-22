# EcoVolt end-to-end telemetry redesign: feature audit and production implementation prompt

This document has two purposes:

1. Audit the important behavior of the current live dashboard so feature parity is explicit.
2. Provide a copy-ready prompt for an AI coding agent to implement the new dashboard from the standalone prototype at **prototypes/dashboard-redesign.html**, including the Python analysis pipeline, realtime event delivery, Convex persistence, and frontend presentation required to make it operational end to end.

The implementation target is the repository at **D:\aaron\documents\EcoVolt**.

---

# Part I — Thorough audit of the current live dashboard

## 1. Current production architecture

The live dashboard is a SolidJS multi-page Vite entry:

- Public route: **/dashboard**
- HTML entry: **dashboard.html**
- Frontend entry: **src/index.tsx**
- Router: **src/App.tsx**
- Main orchestration: **src/pages/DashboardParity.tsx**
- Realtime state: **src/stores/telemetry.ts**
- Realtime transport: **src/lib/ably.ts**
- Convex browser wrapper: **src/lib/convex.ts**
- Authentication: **src/stores/auth.ts** plus **src/components/auth/**
- Active historical application: **public/historical.html** and **public/historical.js**
- Emergency legacy fallback: **/dashboard-legacy**

The live page subscribes to enriched telemetry on the Ably channel named by runtime configuration, normally **telemetry-dashboard-channel**. It does not consume the raw ESP32 channel directly. The Python bridge is responsible for normalization, enrichment, live republishing, Convex persistence, outlier detection, derived telemetry, optimal-speed analysis, and driver recommendations. That makes **backend/maindata.py**, not the browser, the correct authority for new vehicle-performance analysis and operational decision logic.

The current dashboard is not just a collection of charts. Its most important architectural behavior is continuity between realtime Ably data, recent Ably rewind data, and persisted Convex session data.

## 2. Global boot and runtime behavior that must survive the redesign

### 2.1 Runtime configuration and initialization

The dashboard:

- Reads fallback runtime values from window.CONFIG.
- Fetches **/api/config** and merges it with defaults.
- Resolves the Ably authentication URL through the Convex site URL when necessary.
- Loads the Convex browser bundle.
- Initializes the Convex client.
- Initializes custom authentication.
- Starts realtime connection asynchronously after the application shell is usable.
- Shows a startup failure state with access to the emergency fallback dashboard.

The redesign must preserve this initialization order and must not hard-code new frontend secrets.

### 2.2 Realtime connection lifecycle

The current dashboard represents:

- Disconnected
- Connecting
- Connected
- Suspended/reconnecting
- Failed

It exposes:

- A visible connection state.
- A plain-language connection note.
- A retry interaction when retrying is valid.
- Message count.
- Relative last-update time.
- Freshness based on the last received message.

Connection state is not equivalent to data freshness. The redesigned signal rail must keep these concepts separate so “connected but stale” is unmistakable.

### 2.3 Active session discovery

On connection, the dashboard:

- Checks the latest Ably history message for an active session.
- Rejects a latest message that is too old to represent an active run.
- Shows a waiting state if no active session is detected.
- Detects a new session when the first realtime record arrives.
- Detects a session switch and resets session-specific hydration state.

The new dashboard must keep session discovery read-only. The current production system does not expose a trustworthy remote “start session” or “end session” command from the dashboard.

### 2.4 Rewind, hydration, merge, and recovery

For an active session, the current dashboard:

- Buffers realtime records while historical hydration is underway.
- Loads persisted session records from Convex.
- Fetches recent Ably history near the latest Convex timestamp.
- Merges Convex records, Ably history, already-visible records, and buffered realtime records.
- Deduplicates by timestamp plus message ID.
- Prefers real rows over interpolated rows.
- Merges enrichment updates for the same record rather than duplicating them.
- Interpolates only small gaps.
- Retries hydration when too little rewind data is available.
- Recovers after an Ably discontinuity.
- Prevents stale hydration requests from overwriting a newer session.
- Carries bridge-derived fields forward when a fast core record arrives before its enriched counterpart.

This behavior is mission-critical. The redesign must reuse it rather than replacing it with a simpler subscription that loses the beginning of an active run.

### 2.5 Bounded telemetry and derived values

The telemetry store currently:

- Keeps up to 100,000 recent points.
- Normalizes aliases and numeric fields.
- Derives speed in km/h from canonical speed_ms.
- Derives pitch and roll.
- Derives lateral, longitudinal, and total G using bias correction and EMA filtering.
- Integrates steering-wheel gyro data into a bounded steering angle estimate.
- Computes aggregate KPIs.
- Computes data-quality metrics.
- Resets dynamic derivation state on session changes.

The redesigned UI must use shared selectors and shared derived values. It must not reimplement battery, speed, efficiency, G-force, or quality calculations differently in each widget.

## 3. Existing global dashboard controls and navigation

The current header provides:

- EcoVolt/Shell Eco-marathon product identity.
- Connection status and retry behavior.
- Message count and last update.
- A theme toggle with local persistence.
- A historical-analysis button.
- Historical asset prewarming on hover/focus.
- A driver-cockpit button for internal and admin users only.
- A user/account menu.
- A query-string-backed active panel so the selected panel can be restored.

The active live dashboard exposes ten panel modes:

1. Overview
2. Speed
3. Power
4. Motor
5. IMU
6. IMU Detail
7. Efficiency
8. GPS
9. Custom
10. Data

Speed, power, motor, IMU, IMU Detail, efficiency, and GPS include per-panel time windows:

- 30 seconds
- 1 minute
- 5 minutes
- All available data

The new design should retain URL-addressable views, but replace the crowded flat ten-tab model with a compact view switcher organized around operator tasks.

## 4. Existing operational notification and decision behavior

The current dashboard derives transient notifications for:

- No active realtime session after connection.
- A stalled data stream based on observed sample cadence.
- Critical or high-severity outlier bundles.
- Warning-level outlier bundles.
- Missing/unavailable server-side outlier detection.
- Successful active-session hydration.
- Short-gap interpolation during hydration.
- Connection and recovery failures.

Notifications use:

- Sensor-domain grouping.
- Severity mapping.
- Signature-based deduplication.
- Exponential cooldowns.
- Session-aware keys.

The browser-derived states above are mostly transport and hydration concerns. They should become part of the redesigned Attention/event feed, but they are not the only notification path in the system.

The Python bridge already contains a **DriverNotificationEngine**. It analyzes bridge-enriched telemetry for:

- Efficiency improvement or decline.
- Speed deviation from the calculated optimal speed when confidence is sufficient.
- Aggressive throttle/driving patterns.
- Hard braking.
- Low battery voltage.
- High current draw.

It currently analyzes on a reduced stride in the asynchronous heavy-computation path, applies a category cooldown, buffers notifications, and flushes batches to Convex **driver_notifications**. The driver dashboard polls those recommendations every five seconds. This is the foundation to evolve, not functionality to duplicate in SolidJS.

The current path has important reliability and product gaps the implementation must correct:

- It has no active/recovered lifecycle or stable event ID.
- Cooldown is category-level rather than condition/lifecycle-level.
- It does not deliver a realtime pit event over Ably.
- The driver path is polling-only and explicitly non-critical-latency.
- The buffer is cleared before persistence is known to have succeeded, so a missing Convex client or failed write can lose notifications.
- It carries mostly formatted copy rather than structured evidence, threshold, confidence, audience, and affected-view metadata.

The new system should make **backend/maindata.py** the authoritative owner of vehicle, telemetry-quality, performance, strategy, and safety decision events. Evolve the existing engine into a typed stateful operational-decision engine with stable event IDs, active/recovered lifecycle, hysteresis, minimum duration, cooldown, evidence, confidence, target audience, recommended action, occurrence count, and first/last occurrence. Preserve driver-facing delivery while adding pit-dashboard delivery. Browser code may still create explicitly local events for conditions only the browser can observe, such as its own Ably disconnection, hydration failure, view-save failure, or frozen display.

Do not discard the existing frontend cooldown and consolidation behavior where it still applies to browser-local events. Do not independently recalculate backend-owned thresholds in the browser. The Attention feed should merge backend operational events and browser-local delivery events into one coherent presentation while retaining the event source and lifecycle.

## 5. Current panel-by-panel feature inventory

### 5.1 Overview panel

Current information:

- Instant efficiency.
- Optimal speed.
- Current motion-state classification: stationary, accelerating, cruising, braking, or turning.
- Distance.
- Maximum speed.
- Average speed.
- Total energy.
- Average voltage.
- Current current.
- Average power.
- Average current.
- Session duration.
- Record count.

Current instruments:

- Speed gauge.
- Battery gauge.
- Power gauge.
- Instant-efficiency gauge.
- G-force instrument.

Current driver-input region:

- Integrated steering estimate.
- Throttle percentage.
- Brake 1 percentage.
- Brake 2 percentage.
- Collapse/expand behavior.

Important issue to correct: one overview battery gauge estimates percentage as voltage multiplied by two, while the telemetry store uses the 50.4 V to 58.5 V range. The redesign must have one canonical battery estimator and never show contradictory percentages.

### 5.2 Speed panel

Current summary:

- Current speed.
- Average speed.
- Maximum speed.
- Minimum speed.

Current analysis:

- Speed over time.
- Acceleration rate over time.
- Speed-distribution histogram.
- Time spent in speed ranges.
- Synchronized chart cursor behavior.
- Range-specific data filtering.

The redesign should retain these as reusable speed widgets, not a monolithic page that mounts every analysis simultaneously.

### 5.3 Power panel

Current summary:

- Current voltage.
- Current current.
- Current electrical power.
- Total energy.
- Average voltage.
- Average current.
- Average power.
- Peak power.

Current analysis:

- Voltage and current over time.
- Voltage-stability trend.
- Voltage-stability score.
- Current-peak chart.
- Current-peak count.
- Cumulative-energy chart.
- Total cumulative energy.
- Current-spike log with time, current, severity, motion state, and G context.

Current-peak data prefers bridge-provided peak information and falls back to a client-derived statistical threshold only when the bridge has not supplied the field. Preserve that distinction.

### 5.4 Motor/CAN panel

Current live summary:

- Motor RPM with session peak.
- Motor voltage with session average.
- Motor current with session peak.
- Phase 1 current and peak.
- Phase 2 current and peak.
- Phase 3 current and peak.
- Compatibility support for the legacy aggregate/single-phase field.

Current analysis:

- RPM versus vehicle-speed correlation.
- Motor current plus all available phase currents.
- Motor-voltage timeline.
- Operating-envelope bars showing current, minimum, average, and maximum.
- Session-statistics table for RPM, voltage, motor current, and each phase.
- Explicit no-CAN-data state explaining which fields are awaited.

The new Motor & CAN view must handle partial phase availability without presenting missing phases as zero.

### 5.5 IMU overview

Current summary:

- Stability score placeholder.
- Maximum/current G.
- Pitch.
- Roll.

Current analysis:

- Combined six-axis gyro and accelerometer timeline.
- Pitch/roll orientation timeline.
- Vibration magnitude.
- Motion-state classification.

The stability score is currently not implemented and displays a placeholder. The redesign must not invent a fake number. Either implement a documented calculation with thresholds and provenance or label the widget unavailable.

### 5.6 Detailed IMU panel

Current summary:

- Gyro X, Y, and Z.
- Total angular velocity.
- Acceleration X, Y, and Z.
- Total G.

Current analysis:

- Individual Gyro X chart.
- Individual Gyro Y chart.
- Individual Gyro Z chart.
- Individual Accel X chart.
- Individual Accel Y chart.
- Individual Accel Z chart.
- Pitch chart.
- Roll chart.
- Significant acceleration-force peak log.
- Dominant axis for each force peak.
- Angular-velocity histogram.

This depth belongs behind progressive disclosure in the Dynamics view. It should not compete with the live G instrument or the most important vehicle-health state.

### 5.7 Efficiency panel

Current summary:

- Instant efficiency.
- Accumulated efficiency.
- Optimal speed.
- Total route distance.

Current analysis:

- Speed-versus-power scatter plot.
- Efficiency over time.
- Average instant efficiency by speed range.
- Optimal-speed recommendation.
- Expected efficiency at the recommendation.
- Recommendation confidence level and percentage.
- Number of data points supporting the recommendation.
- A collecting-data state before confidence is sufficient.

The redesigned Efficiency Strategy view should translate the recommendation into a simple action statement such as “hold”, “increase pace”, or “ease pace”, while still exposing evidence and confidence.

### 5.8 GPS panel

Current summary:

- Route distance.
- Elevation gain.
- Average speed.
- GPS accuracy when available.
- Current latitude and longitude.

Current controls and visualization:

- Show/hide trail.
- Follow current marker.
- Interactive MapLibre map.
- Start marker.
- End marker.
- Current-position marker.
- Navigation and scale controls.
- Automatic fit to route.
- Follow-latest behavior.
- Sampled point markers for large tracks.
- Hover popup with timestamp, speed, and altitude.
- Altitude versus route distance.
- Speed versus route distance.

The new Track view should keep the immediate schematic track-progress instrument from the prototype and use the full MapLibre map as a secondary detailed widget. The schematic is not a replacement for GPS truth.

### 5.9 Custom charts panel

The current dashboard already has a meaningful customization feature.

Supported metrics:

- Speed.
- Electrical power.
- Battery voltage.
- Battery current.
- Motor voltage.
- Motor current.
- Motor RPM.
- Motor phase 1 current.
- Motor phase 2 current.
- Motor phase 3 current.
- Average/legacy motor phase current.
- Efficiency.
- Throttle.
- Brake 1.
- Brake 2.
- G-force.
- Altitude.
- Gyro Z.

Supported time windows:

- Last 60 seconds.
- Last 5 minutes.
- Last 15 minutes.
- Whole session.

Supported styles:

- Line.
- Area.
- Scatter.
- Bar.
- Histogram.

Existing presets:

- Efficiency Coach.
- Electrical Balance.
- Driver Inputs.
- Motor Watch.
- Stability Watch.

Existing actions:

- Build chart.
- Quick-add preset.
- Edit title.
- Change primary metric.
- Change comparison metric.
- Change time window.
- Change chart style.
- Display current, minimum, maximum, and average.
- Duplicate.
- Remove.

Current persistence is only localStorage under a versioned key. It is device-local, not authenticated, not portable, and not part of a larger view/layout system.

### 5.10 Data and quality panel

Raw-data tools:

- Dynamic columns based on fields present in recent rows.
- All Fields, Core, Power, GPS, IMU, Driver, and Quality column groups.
- Search.
- Sort by any visible column.
- Ascending/descending order.
- Configurable page length from 10 to 500.
- Pagination with compact page buttons.
- Frozen leading columns.
- Friendly labels and unit-aware formatting.
- CSV export.

Quality and bridge information:

- Overall quality score.
- Total records.
- Completeness percentage.
- Missing percentage.
- Connection state.
- Reconnect count.
- Error rate.
- Latency.
- Messages since connection.
- Last update.
- Estimated uptime.
- Data points per minute.
- Session duration.
- Live rate.
- Median sample rate.
- Expected message rate.
- Duplicate count.
- Dropout count.
- Maximum gap.
- Missing-field rates.
- Critical, warning, and informational outlier counts.
- Outliers grouped by field.
- Recent outlier timeline.
- Outlier reasons.
- Quality alerts.
- Quality-score trend.

Important issue to correct: the live Data panel currently renders CSV export without consulting the auth store’s export permission or download limit. The redesign must enforce export policy in the UI and, for sensitive data, through a server-authorized path. Client visibility is not a security boundary.

## 6. Authentication and user-management features

### 6.1 Roles and permissions

Roles:

- Guest.
- External.
- Internal.
- Admin.

Current intended abilities:

- All roles can view realtime telemetry.
- Guests cannot use historical analysis or CSV export.
- External users can access limited historical data and limited export.
- Internal users have full historical/export access and driver-cockpit access.
- Admins additionally have user administration.

The server currently grants external users historical access for the last seven days. Client-side role constants still describe this as one session. The implementation must reconcile this drift and treat Convex authorization as the source of truth.

### 6.2 Account flows

Current account behavior:

- Sign in with email/password.
- Remember-me option.
- Sign up with name, email, password, password confirmation, and requested role.
- External/internal role request.
- Approval-pending success state.
- Session persistence across tabs.
- Storage-event synchronization.
- Revalidate profile when the browser returns online.
- Sign out.
- Account avatar derived from name/email.

### 6.3 Admin user management

Current admin behavior:

- Pending-approval tab with count.
- All-users tab.
- Search users.
- Approve a pending request into the requested/selected role.
- Reject a request.
- Change an existing user role.
- Ban a user.
- Permanently delete a user.
- Protect the current admin from self-ban/self-delete.
- Protect the last administrator.
- Confirm consequential actions.
- Refresh after mutations.
- Display loading and error states.

The redesigned user area must preserve all of this functionality in the new visual system.

## 7. Historical-analysis handoff

The current live dashboard links to **/dashboard/sessions**.

That route is still served by the active vanilla historical application. It provides:

- Auth-gated session explorer.
- Search, sort, and refresh.
- Session metadata and counts.
- Summary KPIs.
- Synced time-series stacks.
- Zoom reset and chart image export.
- Energy analysis.
- Efficiency analytics.
- Driver behavior.
- Descriptive statistics and correlations.
- Anomaly analytics.
- Segments.
- Route map.
- Raw data.
- Cross-session comparison.
- CSV, JSON, clipboard, MATLAB, and Python exports.
- Custom analysis workbench.

The new live dashboard should not attempt to rewrite historical mode as part of this project. Its Historical button must remain prominent, permission-aware, and routed to **/dashboard/sessions**. Preserve prewarming if it remains measurably useful.

## 8. Current UX problems the redesign must solve

1. Ten peer-level tabs make the operator choose a data category before seeing what requires attention.
2. Large sets of visually equal cards make priority hard to scan.
3. Connection, freshness, session, safety, and data quality are distributed instead of forming one health chain.
4. Alerts are transient notifications rather than an inspectable, acknowledgeable operational queue.
5. The overview repeats metrics without turning them into decisions.
6. Deep analysis is always presented as a full panel instead of progressive disclosure.
7. Custom charts are isolated from normal dashboard views.
8. Customization does not travel with the user.
9. Theme and dashboard preferences are device-local.
10. The app has no explicit live-inspection mode with a globally synchronized point in time.
11. Client and server permission descriptions have drifted.
12. Export permissions are not consistently applied in the live dashboard.
13. Some values have inconsistent calculation paths.
14. Some unavailable metrics look like zeros or placeholders rather than unavailable data.
15. Generic emoji-heavy labels and rounded glass panels do not match the newer EcoVolt design system.

## 9. Recommended target information architecture

### 9.1 Global operational spine

Always visible:

- Connection.
- Data freshness.
- Active/waiting session.
- Vehicle health/intervention state.
- Current session name and elapsed time.
- Live versus inspection mode.
- Historical-analysis button.
- Account/users control.
- View switcher.

These elements must not jump position during ordinary telemetry updates.

### 9.2 System views

Provide these curated, built-in views:

1. **Pit Wall** — default immediate state, attention queue, core trend, track progress, battery, power, and G.
2. **Efficiency Strategy** — instant/accumulated efficiency, target pace, optimal-speed recommendation, confidence, speed-power relationship, energy budget.
3. **Power & Energy** — voltage, current, power, battery estimate, cumulative energy, voltage stability, current peaks, power path.
4. **Motor & CAN** — RPM, motor voltage/current, per-phase currents, operating envelope, correlations, partial-CAN state.
5. **Vehicle Health** — consolidated power health, sensor availability, quality score, anomalies, dropouts, freshness, missing fields, current unresolved events.
6. **Dynamics** — planar G, pitch/roll, IMU overview, vibration, individual axes, peaks, angular histogram.
7. **Track** — schematic progress, MapLibre route, current location, follow/trail controls, altitude and speed along route.
8. **Driver Inputs** — steering estimate, throttle, dual brakes, motion state, speed/acceleration context.
9. **Data Integrity** — a calm health summary first, with bridge metrics, quality trend, field-level diagnostics, outlier analysis, raw records, and permission-aware export revealed progressively.
10. **My Views** — user-created workspaces composed from the same widget registry.

System views should be curated defaults, not immutable cages. A signed-in user can clone a system view or save an override. Safety-critical information remains available globally even if a specialized view hides a related widget.

### 9.3 Dynamic priority without layout chaos

Use a deterministic priority model:

- Layer 1: fixed immediate state that never disappears.
- Layer 2: one fixed-size attention slot for the highest unresolved condition.
- Layer 3: user-pinned widgets.
- Layer 4: view-specific widgets.
- Layer 5: secondary details behind disclosure.

Dynamic promotion must happen inside stable slots. Do not reorder the entire dashboard every time a threshold changes.

Examples:

- Offline/stale data replaces the normal state explanation in the immediate-state slot.
- A critical current spike appears in the fixed attention slot and highlights the Power view.
- Missing GPS changes the Track view’s status and gives a next action; it does not remove the last valid position without explanation.
- Low-confidence optimal speed remains secondary and explicitly says more data is needed.

### 9.4 Progressive disclosure and information density

Low cognitive load does not mean removing diagnostic depth. It means presenting depth in the order an operator needs it.

Every specialized view should use three layers:

1. **Status** — the few values and conditions needed to understand the current situation.
2. **Evidence** — the trend, threshold, confidence, affected sensor domain, and short explanation needed to validate it.
3. **Diagnostics** — detailed charts, field lists, raw records, export, and engineering metadata.

Only the first layer is open by default. Use clear **Show evidence**, **Show diagnostics**, or domain-specific expand controls for the rest. Preserve a stable layout when sections expand. Remember disclosure state per view where useful, but default new users to the calm summary. Never hide an active critical condition: surface its title, severity, current evidence, and next action in the summary, then place supporting diagnostics behind expansion.

For **Data Integrity**, the initial viewport should show only:

- Overall data-health state: healthy, degraded, or critical.
- Freshness and actual sample rate versus expected rate.
- Completeness and the most important missing sensor domain.
- Highest unresolved integrity event.
- One recommended next action.

Place maximum gap, dropout/duplicate counts, reconnect and latency metrics, outliers by field, recent outlier timeline, quality trend, missing-field inventory, bridge diagnostics, and raw telemetry table behind labeled disclosure. Raw rows are the final layer, not the first thing an operator sees. Automatically open a diagnostic subsection only when a critical condition requires it, and avoid opening multiple sections at once.

### 9.5 Widget-editing model

Normal mode should be calm and non-editable.

An explicit **Customize view** action enters edit mode. In edit mode users can:

- Add a widget from the registry.
- Add a preset bundle.
- Remove an optional widget.
- Resize within allowed sizes.
- Reorder.
- Edit widget title.
- Change metric/series.
- Change time window.
- Change visualization style where supported.
- Pin/unpin.
- Duplicate.
- Reset a system view to defaults.
- Save.
- Cancel and discard.

The UI must explain unsaved, saving, saved, offline, and conflict states.

On mobile, editing should use move up/down and size controls instead of precision drag-only interaction. All customization must be keyboard operable.

### 9.6 End-to-end intelligence boundary

The redesigned system should have one intentional intelligence path:

**ESP32 raw telemetry → maindata normalization/enrichment → backend analysis and decision state machines → enriched telemetry plus typed operational events → Ably realtime delivery and Convex persistence → dashboard hydration/subscription → prioritized presentation and per-user acknowledgment.**

Responsibilities:

- **backend/maindata.py** owns vehicle-domain calculations, data-quality interpretation, performance analysis, strategy recommendations, safety thresholds, hysteresis, cooldowns, deduplication, recovery detection, evidence, and audience routing. It may use focused helper modules under **backend/**, but maindata remains the pipeline coordinator and integration point.
- **Convex** validates and persists durable operational events, exposes bounded/indexed session queries, stores per-user acknowledgment separately, and enforces authorization.
- **Ably** provides the low-latency delivery path for both enriched telemetry and event transitions. Use a distinct event name or typed envelope so operational events are not mistaken for telemetry samples.
- **SolidJS** hydrates current/recent backend events from Convex, subscribes to live transitions, merges and deduplicates them by stable event ID, applies user acknowledgment to presentation, and renders the correct view/action. It does not rediscover vehicle decisions from raw samples.
- **Browser-local logic** is limited to client-observable delivery and interface state: Ably connection, browser freshness, replay/hydration/interpolation, display freeze, auth, preference-save, and rendering failures. Label these events with a client source and do not present them as vehicle analysis.

The analysis path must never delay the live telemetry fast path. Use bounded rolling windows and incremental statistics; avoid rescanning a whole session per sample. Do not block Ably telemetry republish on Convex writes. Buffer/batch durable event writes, make them idempotent, and define bounded behavior under backpressure or a temporary Convex outage. Measure bridge-to-publish latency before and after the change.

## 10. Proposed persistence model

Customization should be authenticated and stored in Convex. Backend operational events should also be durable in Convex, but use a trusted bridge-ingestion boundary rather than end-user ownership.

Recommended additive tables:

### dashboardPreferences

- ownerUserId.
- default system view key or custom view ID.
- theme.
- preferred displayed speed unit.
- last selected view.
- schemaVersion.
- updatedAt.

Index by ownerUserId and enforce one preferences document per user.

### dashboardViews

- ownerUserId.
- name.
- kind: system override or custom.
- baseSystemViewKey when cloned/overridden.
- isDefault.
- sortOrder.
- schemaVersion.
- revision.
- createdAt.
- updatedAt.

Indexes:

- by owner and sort order.
- by owner and default state if needed.

### dashboardWidgets

- ownerUserId.
- viewId.
- stable instance key.
- widget type from a validated registry.
- optional custom title.
- visibility.
- pinned state.
- priority.
- typed widget configuration.
- desktop placement.
- tablet placement.
- mobile order/size.
- schemaVersion.
- revision.
- createdAt.
- updatedAt.

Indexes:

- by view and order.
- by owner and view if ownership checks need it.

### operationalEvents

Create a durable, typed store for events generated by the backend. Do not overload **driver_notifications** without first mapping and preserving its driver-cockpit behavior. A separate additive **operationalEvents** table is preferred for the richer lifecycle, with a deliberate compatibility path for driver notifications.

Suggested fields:

- sessionId.
- eventId: stable and idempotent across retries.
- fingerprint: stable condition identity used for consolidation.
- source: bridge, analysis engine, or data-quality engine. Browser-local conditions remain ephemeral and are not inserted into this shared authoritative table.
- audience: pit, driver, or both.
- category and affected domain/view.
- severity: info, advisory, warning, or critical.
- status: active, recovered, or resolved.
- title and concise explanation.
- recommendedAction.
- typed evidence including metric IDs, observed values, units, thresholds, and optional confidence.
- firstSeenAt, lastSeenAt, and recoveredAt/resolvedAt.
- occurrenceCount.
- schemaVersion and analysisVersion.

Indexes should support bounded queries by session/time, session/status/severity, and eventId. Backend writes must be idempotent so retries update or upsert the same event lifecycle instead of duplicating rows. Do not write one document per telemetry sample; write on state transition, meaningful evidence update, or a deliberately bounded heartbeat.

### dashboardAlertAcknowledgements

- ownerUserId.
- sessionId.
- stable operational event ID for one event lifecycle. Keep the fingerprint separately for grouping; acknowledging one recovered occurrence must not silently hide a later recurrence.
- acknowledgedAt.
- optionally clearedAt.

Indexes:

- by owner, session, and event fingerprint.
- by owner and session.

Alert acknowledgment only changes presentation. It must not mark an active underlying fault as healthy.

### Persistence behavior

- Guests use curated defaults and an optional versioned local draft.
- Signed-in users load Convex preferences and views.
- On first sign-in after using local customization, offer a one-time import/merge.
- Use optimistic UI with rollback and a visible sync state.
- Debounce layout writes, but flush on edit-mode save.
- Do not write on every telemetry update.
- Use revision numbers or updatedAt conflict detection to prevent silent cross-tab overwrites.
- Limit view and widget counts to prevent unbounded user documents.
- Validate names, layout bounds, widget types, metric IDs, series count, windows, and styles server-side.
- Avoid v.any for persistent widget configuration.

## 11. Production interpretation of prototype-only controls

The prototype contains simulated Start, Pause, End, Reset, state-lab, and connection-state controls. These are demo controls, not current production capabilities.

Production mapping:

- Start session: replace with detected session state; do not create a fake command.
- End session: omit unless a real authenticated bridge control endpoint is separately designed and authorized.
- Reset simulation: omit.
- State lab: development-only story/demo surface, never production.
- Pause feed: implement as **Freeze display**. Keep receiving/buffering telemetry; resume jumps back to current live state.
- Live/Inspect: implement for real bounded live history.
- Reconnect: expose only when connection state makes retry meaningful.

No dead buttons and no control may imply that it changed the vehicle or bridge when it only changed the browser.

---

# Part II — Copy-ready prompt for the implementation agent

## Role and objective

You are a senior product designer, telemetry UX specialist, Python telemetry/backend engineer, SolidJS engineer, Convex engineer, realtime-systems engineer, and performance-focused systems architect.

Fully replace the current main live dashboard at **/dashboard** with a production implementation of the standalone prototype at:

**D:\aaron\documents\EcoVolt\prototypes\dashboard-redesign.html**

Keep the previous current SolidJS dashboard available at:

**https://eco-volt.org/dashboard/old**

This is a real end-to-end production migration, not another prototype and not a frontend-only reskin. Integrate every important current feature described below across the Python telemetry bridge, analysis/decision engine, Ably event delivery, Convex persistence, and new visual/interaction system. Do not deploy publicly or run a production Convex deployment unless the user explicitly asks later.

The result must feel:

- Natural.
- Integrated.
- Actionable.
- Fast.
- Low cognitive load.
- Highly polished.
- Premium.
- Motorsport precise.
- Operationally credible.
- Dynamic without being visually unstable.

## Mandatory repository reading

Before editing, read these files completely:

1. **AGENTS.md**
2. **DESIGN.md**
3. **prototypes/dashboard-redesign.html**
4. **src/pages/DashboardParity.tsx**
5. **src/stores/telemetry.ts**
6. **src/stores/auth.ts**
7. **src/types/telemetry.ts**
8. **src/lib/ably.ts**
9. **src/lib/convex.ts**
10. **src/lib/utils.ts**
11. **src/lib/steeringEstimate.ts**
12. Every active file under **src/panels/** imported by DashboardParity.
13. **src/components/charts/UPlotChart.tsx**
14. **src/components/map/TelemetryMap.tsx**
15. **src/components/table/TelemetryTable.tsx**
16. All active files under **src/components/auth/**
17. **convex/schema.ts**
18. **convex/authHelpers.ts**
19. **convex/users.ts**
20. **convex/historicalAccess.ts**
21. **vite.config.ts**
22. **vercel.json**
23. **dashboard.html**
24. **esp32-variables-guide.md**
25. **backend/maindata.py**, especially OutlierDetector, TelemetryCalculator, OptimalSpeedOptimizer, DriverNotificationEngine, the heavy-computation worker, republish path, notification flusher, and Convex batch writer.
26. **convex/driverNotifications.ts** and the **driver_notifications** schema.
27. **convex/telemetry.ts** and **convex/sessions.ts**.
28. **src/driver/notificationPoller.ts**, **src/driver/store.ts**, **src/driver/DriverDashboard.tsx**, and **src/driver/ablyDriver.ts**.
29. **ARCHITECTURE.md** and **SECURITY.md**.

Also read and follow the available frontend-design, SolidJS, Convex Best Practices, and Convex Functions skills. Before adding Convex functions, verify the latest official Convex guidance for validators, authorization, indexes, queries, mutations, and write conflicts.

## Non-negotiable preservation rules

- Preserve unrelated user changes in the dirty worktree.
- Modify **backend/maindata.py** and, where maintainability requires, focused typed/testable helpers under **backend/** so backend-owned analysis and decision events work end to end. Do not move that intelligence into the frontend.
- Do not change the raw ESP32 field names or units.
- Preserve the enriched telemetry contract unless a versioned additive field is required. Update every producer, validator, type, live consumer, and active historical parser affected by an additive contract change.
- Do not edit convex/_generated by hand.
- Do not use npx convex deploy.
- Do not deploy the frontend.
- Do not move production historical analysis to the incomplete Solid historical implementation.
- Keep **/dashboard/sessions** and **/historical/** routes on the active vanilla historical app.
- Keep **/dashboard-legacy** as the emergency fallback.
- Add **/dashboard/old** as a separate, preserved entry for the current DashboardParity UI.
- Do not add a component library.
- Do not ship Tailwind CDN in production. Translate the prototype into reusable SolidJS components and repository-native CSS.
- Do not add fake vehicle controls.
- Do not weaken auth, historical limits, or export restrictions.
- Do not expose credentials or tokens.
- Do not make telemetry republishing wait for Convex writes or slow analysis.
- Do not create separate pit and driver rules that can disagree about the same vehicle condition.

## Required legacy-route strategy

Preserve the current dashboard before replacing the main entry:

1. Add a dedicated **dashboard-old.html** build entry.
2. Add a small old-dashboard Solid entry that renders the existing DashboardParity implementation with its existing styles.
3. Keep DashboardParity behavior intact for the old route.
4. Add **/dashboard/old** and **/dashboard/old/** handling to the Vite development rewrite.
5. Add a Vercel rewrite from **/dashboard/old** to **/dashboard-old.html**.
6. Add dashboardOld to Vite Rollup inputs so the file exists in dist.
7. Ensure **/dashboard** loads the new dashboard.
8. Keep **/dashboard-solid** behavior intentionally defined rather than accidentally broken.
9. Keep **/dashboard-legacy** pointing to the emergency vanilla fallback.
10. Verify query strings and hashes survive redirects where relevant.

Avoid sharing new global CSS with the old dashboard in a way that visually changes **/dashboard/old**. Namespace the new dashboard styles or give it a dedicated stylesheet.

## Visual source of truth

Use **DESIGN.md** and **prototypes/dashboard-redesign.html** as the visual sources of truth.

Preserve the prototype’s recognizable composition:

- Circuit Black canvas.
- Faint 80 px engineering grid.
- Sharp, square geometry.
- Plus Jakarta Sans interface text.
- Space Grotesk only for telemetry and technical metadata.
- Voltage Orange used for primary focus and selected state.
- Green, teal, and cyan for operational meaning.
- Signal rail across the top.
- Large asymmetric Vehicle Pulse region.
- Integrated speed, power, battery, and track-progress composition.
- Fixed Attention/decision queue.
- Telemetry Evolution region.
- Load & Energy region.
- Orange corner brackets.
- Fine structural rules.
- Dense but calm rhythm.

Do not recreate the old glass-card look inside a dark wrapper. Do not produce a generic sidebar dashboard. Do not convert every widget into an identical rounded card.

## New application architecture

Build a new SolidJS dashboard shell composed of:

- DashboardShell.
- OperationalSignalRail.
- SessionHeader.
- ViewSwitcher.
- ImmediateStateRegion.
- AttentionQueue.
- WidgetGrid.
- WidgetFrame.
- LiveInspectionController.
- CustomizeViewMode.
- AccountMenu.
- HistoricalAnalysisAction.
- DriverCockpitAction.
- ConnectionRecoveryAction.

Create a typed widget registry. Each widget definition should describe:

- Stable widget type.
- Display name.
- Description.
- Supported views/categories.
- Required telemetry fields.
- Optional telemetry fields.
- Allowed sizes.
- Default size.
- Minimum viewport behavior.
- Config validator.
- Rendering component.
- Empty/partial/stale behavior.
- Performance cost classification.
- Whether it is safety-critical, recommended, optional, or analysis-only.

Use Solid’s fine-grained reactivity. Component functions run once; avoid React patterns. Do not destructure reactive props. Use createMemo for shared derived data, Show/For/Dynamic for conditional composition, batch for related updates, and onCleanup for every subscription/listener.

## End-to-end operational intelligence architecture

Implement the dashboard and its supporting intelligence as one system, with explicit ownership and no duplicate decision logic.

### Backend authority in maindata.py

Evolve the existing **DriverNotificationEngine** into, or place it behind, a reusable **OperationalDecisionEngine** coordinated by **TelemetryBridgeWithDB**. Keep the logic in **backend/maindata.py** or focused backend helpers imported by it. The engine must consume normalized/enriched telemetry and bridge health, not UI-formatted values.

Backend-owned analyses include:

- Efficiency improvement/degradation and performance trend detection.
- Speed-to-optimal recommendations gated by optimizer confidence and data sufficiency.
- Aggressive driving and hard-braking patterns.
- Voltage, current, electrical-load, and battery advisories.
- Current and acceleration peak interpretation.
- Outlier bundles and affected sensor-domain summaries.
- Missing/stuck/implausible sensor and data-quality conditions observable at ingestion.
- Sample-rate, gap, dropout, duplicate, processing-lag, and bridge-health conditions observable by the bridge.
- Recovery transitions for every stateful condition.
- Future strategy or decision-support analyses added for the pit or driver.

For each condition, implement an explicit state machine rather than a toast-on-threshold function. Define entry threshold, exit threshold/hysteresis, minimum duration/sample count, cooldown, severity escalation, recovery behavior, evidence, confidence/data sufficiency, and target audience. Centralize rule configuration and version it. Rules must be deterministic and unit-testable with recorded or synthetic sample sequences.

Do not fork contradictory logic between a new pit event engine and the existing driver engine. Either make the richer operational engine produce audience-specific events for **pit**, **driver**, or **both**, or create one shared rules layer with thin audience adapters. Maintain compatibility with the current driver dashboard while migrating it deliberately.

### Typed operational-event contract

Define one additive, versioned contract shared by Python, Convex validation, TypeScript types, and frontend adapters. At minimum include:

- schemaVersion and analysisVersion.
- eventId and stable fingerprint.
- sessionId.
- source.
- audience: pit, driver, or both.
- category, affected domain, and target view.
- severity and lifecycle status: active, recovered, or resolved.
- title, explanation, and recommendedAction.
- typed evidence: metric ID, observed value, unit, comparison/threshold, optional baseline, and confidence.
- firstSeenAt, lastSeenAt, optional recoveredAt/resolvedAt, and occurrenceCount.

Generate event IDs deterministically enough for retry-safe upserts. An eventId identifies one activation lifecycle; a stable fingerprint identifies the condition across lifecycles. A condition that recovers and later reactivates should create a new eventId while retaining the fingerprint, so an old acknowledgment cannot suppress a new problem. Do not place secrets, full raw payloads, or arbitrary unvalidated objects in events. If the event schema changes, update Python serialization, Convex validators/schema/functions, TypeScript types, Ably consumers, and driver compatibility together.

### Delivery, durability, and recovery

- Publish event transitions to the dashboard Ably channel under a distinct event name such as **operational_event**; do not mix them into **telemetry_update** records.
- Persist the same logical event lifecycle to Convex through idempotent batch mutations.
- On dashboard boot or session change, query a bounded set of active and recent session events from Convex, then merge live Ably events by eventId without duplicates.
- Reconnection must recover missed transitions from Convex before the UI claims the feed is current.
- Keep per-user acknowledgment separate from shared event health. Acknowledging an event changes only that user’s presentation.
- Define behavior when Ably succeeds but Convex fails, when Convex succeeds but live publish fails, and when either operation is retried.
- Preserve event ordering using server/source timestamps plus a deterministic tie-breaker; do not assume network arrival order.

### Fast-path and failure isolation

The existing bridge intentionally separates fast telemetry republishing from heavy calculations and database writes. Preserve and strengthen that property.

- Never await a Convex event write in the telemetry republish loop.
- Use bounded rolling windows and incremental aggregates; do not rescan full sessions.
- Run expensive analysis in the existing calculation worker or another bounded worker path.
- Bound event queues and define backpressure behavior. Critical transitions must not be silently lost.
- Flush pending events on clean shutdown where possible.
- Add counters/timings for analysis duration, event queue depth, emitted/upserted/published/dropped events, retry failures, and bridge-to-publish lag.
- A failing rule must be isolated, observable, and unable to stop telemetry delivery.
- Do not log full sensitive payloads or credentials.

### Frontend responsibility

The browser consumes decisions; it does not independently derive vehicle-performance or safety recommendations. Its event selector may rank already-generated active events for display and combine them with client-local delivery states. The browser may generate only conditions that exist at that client, including its Ably connection, received-message freshness, hydration/replay/interpolation status, display freeze, auth state, and preference-save failures. Give local events a distinct source and never persist them as authoritative shared vehicle events.

## Built-in views

Implement:

1. Pit Wall.
2. Efficiency Strategy.
3. Power & Energy.
4. Motor & CAN.
5. Vehicle Health.
6. Dynamics.
7. Track.
8. Driver Inputs.
9. Data Integrity.
10. User custom views.

The view switcher should be compact and URL-addressable using a stable query parameter such as **view**. Browser back/forward must work. Preserve the selected view across reloads for signed-in users and locally for guests.

## Required global immediate state

Within approximately two seconds, an operator must understand:

- Is the realtime link connected?
- Is the current data fresh?
- Is a session active?
- Is the vehicle operating normally?
- What is current speed?
- What is current electrical power?
- What is battery condition?
- Where is the vehicle / how far through the route is it?
- What is the highest-priority unresolved event?
- What should the operator do next?

Keep:

- Last valid values visible when useful.
- Explicit stale/frozen labels.
- Age of last valid sample.
- Unavailable-field explanations.
- Plain-language recovery action.
- Visible units.
- Stable numeric widths.

Do not use color alone.

## Dynamic-priority behavior

Implement a deterministic, testable **presentation-priority selector** in the frontend. Backend event state machines decide whether vehicle, performance, strategy, safety, and bridge-observable data-quality conditions exist. The frontend decides which already-existing condition deserves the fixed Attention slot.

Rules:

- The global immediate-state structure is fixed.
- The Attention slot is fixed-size.
- Critical active conditions outrank warnings.
- New repeated instances consolidate into an occurrence count.
- Acknowledged events recede but do not make active faults healthy.
- User-pinned widgets stay in place.
- Contextual recommendations may update copy and emphasis, not reorder the whole page.
- Rely on backend hysteresis/cooldowns for backend-owned conditions; use frontend cooldowns only for browser-local delivery/interface events.
- A promoted condition should link to or activate the most relevant specialized view.

Convert existing smart notifications into the end-to-end event store, preserving the correct owner:

- No active session: backend when the bridge/session lifecycle can authoritatively know it; otherwise a clearly local waiting state.
- Connection interruption/recovery: backend for ESP32/bridge connectivity, browser-local for that browser’s Ably connection.
- Data stall/staleness: backend for ingestion/sample gaps, browser-local for last-received freshness.
- Missing outlier detection: backend analysis-health event.
- Critical/warning sensor bundles: backend.
- Current spike: backend.
- Battery advisory threshold: backend.
- Efficiency improvement or degradation: backend.
- Session hydration/recovery: browser-local.
- Interpolation information: browser-local presentation/recovery metadata unless interpolation is moved into the bridge.

Every actionable event needs:

- Severity.
- Short title.
- Specific explanation.
- Evidence/value.
- Timestamp.
- Recommended next action.
- Acknowledge action.
- Stable event key.
- Occurrence count.
- Lifecycle status and first/last occurrence.
- Source, audience, affected domain, and target view.
- Confidence or data-sufficiency state when advice is model-derived.

## Live and inspection modes

Implement the prototype’s Live/Inspect interaction against real in-memory telemetry.

Live mode:

- Shows the latest valid data.
- Receives realtime updates.
- Uses readable update rates.

Inspection mode:

- Keeps receiving realtime data in the background.
- Freezes the displayed selection at a stable record key, not an array index.
- Shows a prominent “not live” banner.
- Provides a timeline scrubber.
- Synchronizes selection across relevant charts and map/track.
- Compares the selected point with the previous valid point.
- Compares it with the current live point.
- Shows timestamp and units.
- Provides one obvious Return to live action.
- Escape may return to live when it does not conflict with a modal.

Add a **Freeze display** control only if useful. It must state that acquisition continues in the background.

## Widget parity requirements

Implement reusable widgets covering every current feature.

### Core widgets

- Vehicle pulse: speed_ms as primary canonical display, with optional km/h secondary display.
- Electrical power.
- Battery condition using one canonical estimator.
- Session state and elapsed time.
- Track progress schematic.
- Current location.
- Primary attention event.
- Core multi-series trend.
- Planar G.
- Power flow.
- Driver controls.

### Speed widgets

- Current/average/max/min.
- Speed timeline.
- Acceleration timeline.
- Speed histogram.
- Time in speed ranges.

### Power widgets

- Voltage/current/power/energy summary.
- Voltage and current timeline.
- Voltage stability.
- Current-peak chart.
- Current-spike log.
- Cumulative energy.
- Session average and peak values.

### Motor widgets

- RPM, motor voltage/current, and three phases.
- Missing/partial CAN status.
- RPM-speed correlation.
- Motor/phase current timeline.
- Motor-voltage timeline.
- Operating envelope.
- Min/average/peak table.

### Dynamics widgets

- Planar G instrument.
- Pitch/roll.
- Six-axis overview.
- Vibration.
- Motion classification.
- Per-axis drilldown.
- Force-peak log.
- Angular-velocity histogram.
- Steering estimate.

### Efficiency widgets

- Instant efficiency.
- Accumulated efficiency.
- Optimal-speed recommendation.
- Recommendation confidence and data-point count.
- Speed-power scatter.
- Efficiency trend.
- Efficiency by speed range.
- Distance and energy context.
- Plain-language pace recommendation.

### Track widgets

- Schematic lap/route progress.
- MapLibre detailed route.
- Current/start/end markers.
- Trail and follow controls.
- Fit to track.
- Popup details.
- Coordinates.
- GPS accuracy.
- Route distance.
- Elevation gain.
- Altitude profile.
- Speed along route.

### Health/data widgets

Organize these widgets with progressive disclosure instead of rendering every metric at once.

**Always-visible summary:**

- One data-health state: healthy, degraded, or critical, with text as well as color.
- Freshness.
- Sample rate/median Hz compared with expected rate.
- Completeness and the most important missing sensor domain.
- Highest unresolved data-integrity event.
- One recommended next action.

**Evidence layer, collapsed by default:**

- Quality score and trend.
- Maximum gap.
- Dropout and duplicate counts.
- Outlier severity and affected fields.
- Compact recent-event timeline.
- Short explanation of how the state was determined.

**Engineering diagnostics, collapsed by default:**

- Full missing-field inventory.
- Outliers by field and recent outlier details.
- Error, reconnect, processing-latency, queue-depth, and publish-lag metrics.
- Bridge/analysis health and analysis version.
- Raw telemetry table.
- Permission-aware export.

Use explicit **Show evidence** and **Show diagnostics** controls, an accessible accordion, or a similarly clear disclosure pattern. Keep only one dense diagnostic group open at a time on small screens. Do not make users expand a section to discover that a critical integrity problem exists: the summary must expose the problem and next action, while expansion reveals the proof. Do not put the raw table above the summary or open it by default.

### Custom chart widgets

Retain all current custom metrics, time windows, styles, presets, summary statistics, edit, duplicate, and remove behavior. Integrate custom charts into the general widget registry instead of keeping a separate isolated implementation.

## Widget customization and custom views

Implement an explicit customization workflow:

- Customize current view.
- Add widget.
- Search/filter widget catalog.
- Add preset groups.
- Reorder.
- Resize within constraints.
- Configure.
- Duplicate.
- Remove optional widget.
- Pin.
- Rename custom view.
- Clone system view.
- Create blank view.
- Duplicate view.
- Delete custom view with confirmation.
- Set default view.
- Reset system override.
- Save/cancel.

Safety requirements:

- Connection, freshness, session state, and highest-priority event remain globally available.
- The user cannot remove all paths back to immediate state.
- Editing does not activate during normal monitoring.
- Major controls do not move when telemetry updates.
- Mobile customization has non-drag alternatives.

## Convex persistence and operational-event implementation

Add typed, additive schema and functions for durable operational events, user preferences, views, widgets, and per-user alert acknowledgments.

Requirements:

- Use the existing custom authentication token flow and requireCurrentUserId helpers.
- Never authorize by client-provided email.
- Every preferences, view, widget, and acknowledgment document is owned by the authenticated authUsers ID. Operational events are shared session records written by the trusted bridge path and read according to existing realtime/session access policy; do not pretend they have an end-user owner.
- Every public query and mutation has argument and return validators.
- Use indexes for owner/view lookups.
- Do not use unbounded collect.
- Do not use v.any for widget configuration.
- Do not use Date.now inside reactive queries.
- Mutations may assign createdAt/updatedAt.
- Make save/import/delete operations idempotent where appropriate.
- Use ConvexError with stable codes for user-facing failures.
- Enforce per-user limits such as maximum custom views and maximum widgets per view.
- Validate layout coordinates and sizes.
- Validate widget type, metric IDs, chart style, series count, and time window.
- Keep exported functions thin and move shared logic into typed helpers.
- Do not use actions for normal database reads/writes.
- Do not schedule public functions.
- Never expose an unauthenticated public event-write mutation. Use a genuinely trusted bridge-ingestion path: for example, an authenticated Convex HTTP action that validates a server-side secret from Convex environment variables and calls an internal mutation, or an equivalent mechanism supported by the current Convex deployment. Keep bridge credentials only in backend/Convex environment variables, use constant-time secret comparison where applicable, restrict methods/CORS, and never send the credential to the browser.
- Upsert operational events by stable eventId or a unique indexed identity so retries are idempotent.
- Query active and recent events through bounded indexed reads; never scan a whole session.
- Store typed evidence with explicit validators rather than v.any.
- Keep driver_notifications compatible during migration. Avoid double-inserting the same recommendation into two user-visible feeds.

Suggested functions:

- internal.operationalEvents:upsertBatchFromBridge, reached only through the authenticated bridge-ingestion path
- operationalEvents:listActiveForSession
- operationalEvents:listRecentForSession
- operationalEvents:getSinceCursor or an equivalent bounded recovery query
- dashboardPreferences:getMine
- dashboardPreferences:updateMine
- dashboardViews:listMine
- dashboardViews:create
- dashboardViews:rename
- dashboardViews:duplicate
- dashboardViews:remove
- dashboardViews:setDefault
- dashboardViews:reorder
- dashboardViews:resetSystemOverride
- dashboardWidgets:upsert
- dashboardWidgets:remove
- dashboardWidgets:replaceViewLayout
- dashboardWidgets:importLocalDraft
- dashboardAlerts:listAcknowledgements
- dashboardAlerts:setAcknowledged
- dashboardAlerts:clearAcknowledged

The exact module split may differ, but keep it domain-oriented and typed.

The bridge must batch or coalesce event persistence separately from telemetry persistence. A temporary Convex outage must not block **telemetry_update** publication. Retry with bounds and idempotency, expose failure counters, and flush safely on shutdown where possible.

## Guest and signed-in behavior

Guest:

- Can view realtime telemetry.
- Can view shared operational events; any acknowledgment is local to the browser/session and must not mutate shared event health.
- Uses curated system views.
- May keep a versioned local draft if customization is allowed.
- Cannot write user view records to Convex.
- Cannot access historical analysis or export.

Signed-in:

- Loads Convex-backed views and preferences.
- Loads active/recent shared events and their own persisted acknowledgments.
- Receives optimistic edit feedback.
- Sees saving/saved/offline/conflict states.
- Can import a previous local custom-chart configuration once.

External:

- Respect the server’s current historical window.
- Respect export limits.

Internal/admin:

- Full permitted history/export.
- Driver-cockpit action.

Admin:

- Full user-management surface.

Reconcile client permission constants with server policy. Server checks remain authoritative.

## User/account surface

Preserve and restyle:

- Login.
- Remember me.
- Signup.
- Name/email/password/confirmation.
- Requested external/internal role.
- Pending-approval state.
- Avatar.
- Role and approval status.
- Sign out.
- Admin access.

Admin surface must preserve:

- Pending and all-user modes.
- Pending count.
- Search.
- Approve.
- Reject.
- Role change.
- Ban.
- Delete.
- Consequential confirmations.
- Last-admin protection.
- Self-action protection.
- Loading, success, and error feedback.

Add dashboard preferences and My Views to the account surface without burying Historical Analysis or Sign out.

## Historical and driver navigation

Historical:

- Provide a visible, labeled **Historical Analysis** button.
- Route to **/dashboard/sessions**.
- Explain access restrictions rather than failing silently.
- Keep historical prewarming only if it does not compete with live startup.

Driver:

- Provide a labeled **Driver cockpit** action for internal/admin users.
- Route to **/driver**.
- Preserve the existing access gate.

Previous dashboard:

- Provide a quiet **Previous dashboard** link to **/dashboard/old**, preferably in the account/help area rather than as a competing primary action.

## Charts and data performance

Reuse uPlot, MapLibre, and TanStack Solid Table.

Requirements:

- Only mount heavy widgets for the active view or open disclosure.
- Share time-window selectors and derived arrays.
- Avoid cloning the entire 100,000-point store for every widget update.
- Use indexed/windowed selection where possible.
- Downsample only for rendering; preserve source data for summaries.
- Keep chart history bounded by the widget window.
- Use uPlot setData rather than recreating charts per sample.
- Keep chart cursor synchronization scoped and cleaned up.
- Pause expensive rendering when the tab is hidden.
- Resume with current state without replaying avoidable work.
- Keep map marker sampling bounded.
- Keep raw-table pagination.
- Do not animate high-frequency values.
- Do not introduce a new heavy chart library.

## Data correctness

- Canonical speed remains speed_ms in m/s.
- Display conversion to km/h must be explicit.
- Electrical power is W.
- Energy_j remains J; derived kWh conversion must be correct.
- Efficiency is km/kWh.
- G components are g.
- Acceleration is m/s².
- Gyro is degrees/second.
- Timestamps are ISO 8601.
- Negative current/power may represent regeneration.
- Missing values display as unavailable, not zero.
- Last valid values may remain visible when stale but must be marked.
- Do not show optimal-speed advice below its confidence threshold.
- Do not fabricate GPS accuracy, stability scores, alerts, or vehicle-control effects.

## Alert and threshold design

Centralize vehicle, performance, safety, and bridge-observable data-quality thresholds in the backend analysis layer used by **maindata.py**. Document units, rationale, entry/exit values, minimum duration, confidence requirements, and rule/analysis version. The browser must not carry a second copy of those thresholds.

Frontend thresholds are allowed only for client-local presentation state, such as how long since this browser received an update before it labels the display stale. Name and document them separately so they cannot be confused with vehicle rules.

Use:

- Hysteresis.
- Minimum duration.
- Deduplication.
- Cooldowns.
- Sensor-domain grouping.
- Recovery events.
- Data-sufficiency/confidence gates.
- Explicit audience routing.

An event’s copy must answer:

- What happened?
- What value/evidence triggered it?
- When?
- Is it still active?
- What should the operator do?

Avoid repeating the same alert every telemetry sample.

Positive coaching such as efficiency improvement must also be rate-limited and evidence-based. Decision advice must never be shown when required fields are missing, stale, implausible, or below its confidence threshold. If evidence becomes invalid, recover or suppress the event explicitly instead of leaving stale advice active.

## Responsive requirements

Target:

- 1440 px desktop.
- 1024 px laptop/tablet.
- 390 px mobile.

Desktop:

- Preserve the asymmetric 8/4 operational composition.
- Use the instrument grid.
- Keep analysis aligned to shared axes.

Tablet:

- Preserve immediate state and attention above deep analysis.
- Avoid cramped ten-tab navigation.

Mobile:

- Recompose rather than shrink.
- Show connection, freshness, session, safety, speed, power, battery, and primary action first.
- Keep a fast Return to live control.
- Put secondary analysis behind labeled disclosure.
- Turn dense tables into an intentional scroll region or labeled rows.
- No horizontal page overflow.
- Minimum 44 by 44 px targets.
- Provide non-drag widget-order controls.

## Accessibility

- Semantic header, nav, main, section, aside, and dialog landmarks.
- Proper buttons and links.
- Logical focus order.
- Visible orange focus treatment.
- Keyboard-operable view switching, event acknowledgment, chart toggles, inspection, customization, and modals.
- Text reinforcement for every state.
- Sufficient contrast.
- Accessible names for icons.
- Accessible chart summary and current values.
- Reduced-motion support.
- Focus trapping and restoration for dialogs.
- Announce save, connection, mode, and consequential event changes without flooding live regions.

## Error, empty, stale, and partial states

Implement explicit states for:

- Dashboard booting.
- Configuration failure.
- Convex failure.
- Ably connecting.
- Reconnecting.
- Offline.
- Connected but waiting for a session.
- Active session hydration.
- Rewind recovery.
- Live but stale.
- Partial telemetry.
- Invalid payload/error.
- No CAN data.
- No GPS.
- Missing IMU.
- Missing outlier detection.
- Analysis engine degraded or rule failure.
- Operational-event persistence delayed while live telemetry continues.
- Operational-event hydration/recovery in progress.
- Empty custom view.
- View save failure.
- View conflict.
- Permission-limited historical/export.

Each must explain the next action.

## Theme

Circuit Black is the primary theme. Preserve the current theme feature by implementing a fully designed light “technical sheet” variant or explicitly retaining a polished dark-only preference until the light variant is complete. Do not keep a theme toggle that produces an unfinished or low-contrast theme.

Persist theme locally for guests and in dashboardPreferences for authenticated users.

## Migration behavior

- Existing CustomPanel localStorage widgets should be detected.
- Provide a safe conversion into the new custom-widget schema.
- Never delete the old localStorage value until Convex import succeeds.
- Mark the migration version.
- Avoid duplicating imports across reloads.
- System default views should be code-defined and versioned.
- Apply new defaults without overwriting user-modified layouts.

## Implementation sequence

1. Inspect status and create a feature checklist from the current code.
2. Add and verify **/dashboard/old** before changing the main dashboard.
3. Map every current notification/decision to its authoritative owner: bridge, shared backend analysis, or browser-local delivery state.
4. Define and version the shared operational-event contract across Python, Convex, and TypeScript.
5. Refactor/evolve the **maindata.py** notification path into testable stateful operational analysis with hysteresis, recovery, evidence, audience, and idempotent IDs.
6. Add Convex operational-event schema, indexed bounded reads, trusted idempotent bridge writes, and per-user acknowledgments while preserving driver-notification compatibility.
7. Add non-blocking Ably operational-event publishing, batched Convex persistence, retry/recovery, metrics, and clean-shutdown flushing to the bridge.
8. Verify the backend event pipeline and measure that it does not materially regress telemetry republish latency.
9. Create the new namespaced design tokens and shell.
10. Reuse the existing realtime/auth boot pipeline and add event hydration/subscription/deduplication.
11. Extract shared telemetry selectors and canonical presentation calculations; remove duplicated decision thresholds from the client.
12. Build the widget registry.
13. Implement the Pit Wall view and fixed Attention presentation first.
14. Implement Live/Inspect mode.
15. Port every current panel feature into reusable widgets.
16. Implement built-in specialized views, including the progressively disclosed Data Integrity view.
17. Add Convex schema and functions for preferences/views/widgets.
18. Add customization edit mode and local migration.
19. Integrate auth, admin, Historical Analysis, Driver cockpit, and Previous dashboard.
20. Implement responsive and accessibility behavior.
21. Verify permissions, event recovery, and all error/degraded states.
22. Run relevant repository checks.
23. Stop before deployment and report manual verification URLs.

## Verification requirements

Run:

- python -m py_compile backend/maindata.py
- Focused backend analysis/event tests using synthetic sequences for entry, hold, escalation, recovery, cooldown, confidence gating, and retry-safe IDs.
- npm run typecheck
- npx tsc -p convex/tsconfig.json --noEmit
- npm run build

Run a safe local/mock bridge verification when dependencies and non-production configuration are available. Do not connect to or mutate production merely to complete verification. Capture evidence for:

- Enriched **telemetry_update** messages continue while Convex event persistence is unavailable or retrying.
- Backend conditions emit one active transition, consolidate repetitions, and emit recovery rather than flooding every sample.
- The same logical event is not duplicated after a retry.
- Pit-only, driver-only, and shared audiences route correctly.
- The driver dashboard still receives compatible recommendations.
- Active/recent events hydrate from Convex and live Ably transitions merge without duplicates.
- Bridge analysis time, queue depth, failure counters, and bridge-to-publish lag remain bounded and observable.

Manually verify:

- **/dashboard**
- **/dashboard/old**
- **/dashboard/sessions**
- **/driver** access behavior
- Desktop approximately 1440 px.
- Tablet approximately 1024 px.
- Mobile approximately 390 px.
- Browser console.
- Realtime connected/waiting/active states.
- Reconnection and stale state.
- Backend operational-event active/escalated/recovered lifecycle.
- Browser-local connection/freshness events are visibly distinct from backend vehicle decisions.
- Event recovery after a simulated Ably disconnect.
- Per-user acknowledgment without changing shared underlying health.
- Session switch and rewind hydration.
- Every built-in view.
- Data Integrity summary is understandable without expansion; evidence, diagnostics, and raw data are available behind clear disclosure.
- Widget add/edit/reorder/resize/duplicate/remove.
- Custom-view create/rename/duplicate/delete/default.
- Reload persistence.
- Cross-tab or second-window update conflict behavior.
- Guest behavior.
- External behavior.
- Internal behavior.
- Admin user-management behavior.
- Historical button and permission denial.
- Export permission and limits.
- Live/Inspect selection and Return to live.
- Keyboard navigation.
- Reduced motion.

Do not claim visual approval. Hand the completed implementation to the user for manual review.

## Definition of done

The task is complete only when:

- The new dashboard at **/dashboard** visually and behaviorally follows the prototype.
- The previous current dashboard works at **/dashboard/old**.
- Every important current live-dashboard capability exists in the new widget/view system.
- Vehicle-performance, strategy, safety, and bridge-observable data-quality analyses run authoritatively in the **maindata.py** backend pipeline, not as duplicated frontend rules.
- Typed operational events travel end to end through backend state machines, Ably live delivery, Convex durability/recovery, frontend prioritization, and per-user acknowledgment.
- Backend events are stateful, deduplicated, evidence-based, confidence-aware, and produce recovery transitions.
- The event/analysis path does not block or materially degrade live telemetry republishing.
- The realtime rewind/hydration/recovery pipeline still works.
- Users, roles, admin controls, Historical Analysis, and Driver cockpit are integrated.
- Custom views and widget layouts persist safely in Convex for authenticated users.
- Guest behavior remains usable.
- Permission limits are enforced.
- The interface is responsive, accessible, and stable under live updates.
- Deep diagnostics remain available through progressive disclosure without hiding critical state or overwhelming the default view.
- All relevant checks pass.
- No production deployment was performed.
