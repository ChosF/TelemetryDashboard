# EcoVolt Repository Guide

## Scope and current layout

- This file applies to the entire repository.
- Run Node, Convex, Vite, and Python commands from the repository root.
- Treat paths below as relative to the repository root unless stated otherwise.
- Before editing, inspect `git status` and preserve unrelated user work.

## What this project is

EcoVolt is a multi-page telemetry system for a Shell Eco-marathon vehicle:

1. ESP32 hardware publishes raw telemetry to Ably channel `EcoTele`.
2. `backend/maindata.py` consumes the raw stream, enriches it, publishes live dashboard data to `telemetry-dashboard-channel`, and batches persistent records into Convex.
3. The driver cockpit reads the raw `EcoTele` stream for minimum latency and polls Convex for notifications.
4. The pit dashboard combines enriched Ably data with Convex session hydration.
5. Historical analysis reads paginated session data from Convex.

The main stack is SolidJS, TypeScript, Vite, Convex, Ably, uPlot, MapLibre GL, TanStack Solid Table, and a Python telemetry bridge.

## Canonical application surfaces


| Surface             | Route / entry                          | Implementation                                                            |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| Landing site        | `/`, `index.html`                      | Static HTML                                                               |
| Pit dashboard       | `/dashboard`, `dashboard.html`         | `src/index.tsx` → `src/App.tsx` → `src/pages/DashboardParity.tsx`         |
| Driver cockpit      | `/driver`, `driver.html`               | `src/driver/index.tsx` → `DriverDashboard.tsx`                            |
| Historical analysis | `/dashboard/sessions`, `/historical/*` | Active vanilla app in `public/historical.html` and `public/historical.js` |
| Legacy fallback     | `/dashboard-legacy`                    | `public/legacy-dashboard-do-not-use/`; emergency fallback only            |


`src/pages/HistoricalMode.tsx` and related Solid components are an incomplete migration. Production historical routes still resolve to `historical.html`. Do not assume the Solid historical implementation is live.

## High-value files

- `src/pages/DashboardParity.tsx`: primary live-dashboard orchestration.
- `src/stores/telemetry.ts`: reactive telemetry state and live/historical merge behavior.
- `src/types/telemetry.ts`: frontend telemetry contract.
- `src/lib/ably.ts` and `src/driver/ablyDriver.ts`: enriched and raw Ably clients.
- `src/lib/convex.ts`: browser Convex wrapper and paginated loading.
- `src/stores/auth.ts`: client roles and permissions.
- `convex/schema.ts`: database schema and indexes.
- `convex/telemetry.ts`, `convex/sessions.ts`: telemetry persistence and historical access.
- `convex/auth.ts`, `convex/users.ts`: custom authentication and role approval.
- `convex/http.ts`: `/ably/token` and `/health`.
- `backend/maindata.py`: ingestion, enrichment, republishing, and Convex batching.
- `esp32-variables-guide.md`: canonical hardware payload names and units.
- `vite.config.ts` and `vercel.json`: actual build entries, routes, and deployment output.

## Development workflow

Requirements: Node.js 18+, npm, Python 3.8+, a linked Convex deployment, and Ably credentials.

```powershell
cd TelemetryDashboard
npm install
Copy-Item .env.example .env.local
```

Use separate terminals as needed:

```powershell
npm run dev          # Vite at http://localhost:3000
npm run dev:convex   # Convex development deployment and code generation
python backend/maindata.py
```

The Python bridge is only needed for real telemetry ingestion/persistence. Its direct imports require `ably`, `requests`, and `numpy`. `backend/mock_driver.py` publishes mock raw data to `EcoTele`.

Do not use `npx convex deploy` for ordinary development; it targets production. Do not run production deployments, alter cloud data, or rotate credentials unless explicitly requested.

## Verification

Use the checks relevant to the files changed:

```powershell
npm run typecheck
npx tsc -p convex/tsconfig.json --noEmit
npm run build
```

- `npm run typecheck` covers `src/` and `vite.config.ts`, but excludes `convex/` and `public/`.
- There is currently no automated test suite.
- `npm run lint` is declared but unusable because ESLint and its configuration are absent.
- `npm run clean` uses Unix `rm -rf` and does not work in standard PowerShell.
- For UI or routing changes, manually verify the affected route at desktop and mobile widths and check the browser console.

## Code conventions

### SolidJS and TypeScript

- This is SolidJS, not React. Use Solid primitives such as `createSignal`, `createMemo`, `createEffect`, `Show`, `For`, and `onCleanup`.
- Keep TypeScript strict and avoid `any`. Reuse types from `src/types/`.
- Use the `@/` alias for `src/` imports.
- Preserve the multi-page architecture. A new top-level surface may require an HTML entry, a Vite Rollup input, dev rewrite handling, and a Vercel rewrite.
- Keep high-frequency telemetry work allocation-conscious. Avoid unnecessary array copies, broad reactive dependencies, and per-sample component churn.
- Preserve the current CDN-based Convex browser-client arrangement unless the task explicitly includes migrating it.

### Convex

- Never edit `convex/_generated/`; regenerate it with `npm run dev:convex`.
- For every new or modified public query, mutation, or action, define argument and return validators.
- Enforce authorization in Convex functions; client-side role checks are not a security boundary.
- Use indexes instead of post-query filtering. Use cursor/batch pagination for large telemetry sessions rather than unbounded `.collect()`.
- Do not introduce `Date.now()` into reactive queries; pass time as an argument or model expiry so query caching remains deterministic.
- Await all promises. Keep exported Convex wrappers thin and move reusable logic into typed helper functions.
- Schedule only internal functions.
- Schema changes affecting existing data require a migration plan; do not assume destructive schema changes are safe.

### Telemetry contract

- Preserve exact field names and units from `esp32-variables-guide.md`; speed is m/s, electrical power is W, cumulative energy is J, and timestamps are ISO 8601 strings.
- When adding or renaming telemetry fields, inspect and update all relevant layers:
  - `esp32-variables-guide.md`
  - `backend/maindata.py`
  - `convex/schema.ts` and Convex validators
  - `src/types/telemetry.ts`
  - live dashboard and driver consumers
  - active historical parsing/export code
- Keep `EcoTele` and `telemetry-dashboard-channel` meanings distinct and synchronize channel configuration across the Python bridge, HTML runtime config, and both Ably clients.
- Preserve large-session pagination through `getSessionRecordsBatch` or cursor-based queries.

### Authentication and permissions

- Authentication is custom Convex email/password auth, not a standard Convex Auth component.
- Roles are `guest`, `external`, `internal`, and `admin`. Historical/export limits are enforced server-side and mirrored in `src/stores/auth.ts`.
- Changes to roles or permissions must update both client affordances and Convex authorization checks.
- Driver access is intended for `internal` and `admin` users.

## Security rules

- Never add, copy, print, or commit API keys, deploy keys, passwords, or session tokens.
- Some existing files contain embedded credentials. Treat them as exposed legacy secrets: do not repeat their values in code, docs, logs, diffs, or responses.
- Prefer Convex environment variables and short-lived Ably token authentication through `ABLY_AUTH_URL`; do not add new frontend `ABLY_API_KEY` usage.
- `.env`, `.env.local`, `.env.*.local`, `.vercel/`, and local logs stay untracked.
- Avoid logging full telemetry payloads when they may contain identifiers or operational data.
- Keep authorization and input validation server-side. Restrict CORS when changing production HTTP behavior.

## Generated, vendor, and deprecated areas

Do not hand-edit:

- `convex/_generated/`
- `dist/`
- `node_modules/`
- `vite.config.ts.timestamp-*.mjs`
- vendored uPlot assets under `public/lib/`

Do not extend `public/legacy-dashboard-do-not-use/` for normal work. The active vanilla historical app under `public/historical*` is not deprecated, but it is large and migration-sensitive; make targeted changes and keep behavior aligned with the Solid telemetry types.

## Build and deployment facts

- `npm run build` produces `dist/`.
- `vercel.json` is authoritative: Vercel runs `npm run build`, serves `dist`, and rewrites the application routes.
- The Vercel project root is the repository root.
- `npm run deploy` deploys Convex only; it does not deploy the frontend.
- The Python bridge is a separate local/on-premises process and is not hosted by Vercel.

## Documentation trust order

Use code and configuration as the source of truth, then:

1. `README.md` for the overview.
2. `esp32-variables-guide.md` for hardware telemetry fields.
3. `ARCHITECTURE.md` for the data-flow model.
4. `SECURITY.md` for intended security policy.

`DEPLOYMENT.md`, `QUICKSTART.md`, `CONVEX_SETUP.md`, and parts of `TROUBLESHOOTING.md` are stale. In particular, ignore claims that Vercel serves `public/`, that configuration belongs in `public/index.html`, that the primary dashboard is vanilla `app.js`, or that maps use Leaflet. Current code builds to `dist/`, uses per-entry runtime configuration, runs the primary dashboard in SolidJS, and uses MapLibre.

When behavior and documentation differ, verify the implementation and update the affected documentation as part of the same task when in scope.