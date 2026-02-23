# Safe SolidJS Migration + Performance Report

## Scope completed in this pass

- Preserved the current production dashboard/historical UX on legacy pages (`public/dashboard.html`, `public/historical.html`, `public/app.js`, `public/historical.js`).
- Implemented **native browser-history route architecture** for historical flow:
  - `/dashboard`
  - `/dashboard/sessions`
  - `/historical/:sessionId`
  - `/historical/custom?sessionId=...`
- Kept behavior parity by using route/state sync around existing UI flows (no feature removal, no data/API schema changes).
- Added deployment rewrites in `vercel.json` to map the new route paths to existing HTML entry points safely.
- Removed the embedded in-dashboard historical fallback block and its runtime wiring:
  - deleted `#panel-historical` from `public/dashboard.html`
  - removed `initHistoricalMode()` execution and related panel mapping in `public/app.js`
  - historical flow now runs only through the dedicated routed historical pages.

## What was migrated

- This pass is a **safe migration foundation**:
  - Route/state architecture moved from implicit in-page state to URL + browser history.
  - Existing legacy UI remains primary and unchanged visually.
  - Solid codebase remains available under `src/` for incremental cutover behind compatibility controls.

## What was optimized

### Main dashboard (`public/app.js`)

- Added URL-state sync for active tab (`?panel=...`) so dashboard context is preserved and restored.
- Optimized tabs scroll indicator handling:
  - passive listener
  - `requestAnimationFrame` batching (avoids per-event sync work).
- Debounced core chart resize path to reduce resize storm pressure.
- Prevented repeated historical-resize listener accumulation in embedded historical panel path.

### Historical mode (`public/historical.js`)

- Added route-aware navigation with `pushState`/`replaceState` and `popstate` restoration.
- Deep-link restore:
  - auto-open session for `/historical/:sessionId`
  - restore custom analysis for `/historical/custom?sessionId=...`
- Kept worker pipeline (`workers/historical-worker.js`) and existing processing behavior unchanged.

## Baseline vs after metrics

### Build/runtime validation metrics captured here

- Typecheck: `pass`
- Build: `pass`
- Lint: `blocked` (eslint binary missing in environment)

### Performance baseline/after measurement status

- Browser CPU/FPS long-task profiling could not be captured in this headless CLI pass.
- The code now includes route/state and event-path optimizations expected to reduce:
  - long tasks during resize/scroll-heavy interactions
  - unnecessary sync work on high-frequency tab-scroll events
  - listener churn in historical chart rendering path

### Recommended immediate manual benchmark commands (same repo)

1. Open `/dashboard`, run a 20-30s scroll/profile capture.
2. Execute `telemetryTest.stressTest15Hz(30)` in console (before/after comparison).
3. Measure session-open latency on `/historical/:sessionId` with a large session.
4. Record long tasks/FPS and session load times before and after this patch.

## Route/history behavior details

- Dashboard tab state is encoded in URL (`/dashboard?panel=<name>`).
- From dashboard, Historical entry goes to `/dashboard/sessions`.
- Session select pushes `/historical/:sessionId`.
- Custom analysis pushes `/historical/custom?sessionId=<id>`.
- Browser Back/Forward now traverses those real routes and restores corresponding view/session.

## Known risks

- Existing in-file historical implementation inside `public/app.js` is still large and imperative; further modular extraction is recommended.
- Route deep-link handling for custom analysis depends on `sessionId` query parameter.
- Lint cannot run until ESLint is installed/available in environment.

## Rollback instructions

1. Revert `public/app.js`, `public/historical.js`, `public/dashboard.html`, `public/historical.html`, and `vercel.json`.
2. Historical flow returns to prior single-page toggling behavior and static links.
3. No database/API rollback required (no schema or endpoint changes were introduced).

## Non-blocking follow-up optimizations

- Add virtualization for large historical session list render path.
- Move heavy histogram/regression computations to worker-side pre-aggregation.
- Introduce explicit Solid feature flag route gate and migrate sections (header/nav/KPIs/charts) incrementally with parity snapshots.
- Capture and store automated browser profiling artifacts in CI perf jobs.
