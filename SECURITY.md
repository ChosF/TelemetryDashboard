# Security Guidelines

## Security model

EcoVolt uses a Convex-native email/password system. Convex functions are the trust boundary: browser role checks are only UI affordances, and every protected query or mutation must validate the session and permission again on the server.

The authentication implementation is split by responsibility:

- `convex/auth.ts`: Node actions for password hashing and public sign-in/sign-up/sign-out flows.
- `convex/authInternal.ts`: transactional account, session, rate-limit, expiry, and audit-log operations.
- `convex/authHelpers.ts`: shared session validation for protected Convex functions.
- `convex/users.ts`: server-enforced role and account administration.
- `src/lib/authSession.ts`: the single browser session-storage contract used by the Solid dashboard and driver cockpit.
- `public/auth.js`: equivalent session handling for the active vanilla historical application.

## Passwords and registration

- New passwords must be 12–128 characters. Unicode and whitespace are allowed and passwords are never silently trimmed.
- Passwords are hashed with scrypt (`N=2^17`, `r=8`, `p=1`) and a unique 128-bit salt.
- Hashes are versioned so work factors can be upgraded later.
- Legacy fast SHA-256 hashes are accepted only for a successful login and immediately replaced with scrypt.
- `AUTH_PASSWORD_PEPPER` is optional but strongly recommended. Configure it as a high-entropy Convex environment variable before creating accounts. Do not change or remove it without a password-migration plan.
- Email is normalized and length/format checked on the server.
- Display names are normalized, limited to 80 characters, and restricted to plain-name characters. They are still treated as untrusted when rendered.
- Registration can request only `external` or `internal`. Account and profile creation happen in one server transaction; the client cannot provide a user ID, effective role, or approval state.
- Sign-in and sign-up are rate-limited per normalized-email digest. Error messages do not reveal whether an account exists.

## Sessions

- Session identifiers contain 256 bits of cryptographic randomness.
- Convex stores only SHA-256 digests of session tokens, never the bearer tokens themselves.
- Non-remembered sessions expire after 12 hours and live in `sessionStorage`.
- “Remember me” sessions expire after 30 days and live in `localStorage`.
- A user can have at most eight current sessions. Creating another removes the oldest.
- Expiry is enforced during validation and by a durable scheduled Convex mutation.
- Sign-out deletes the server-side session. Banning or deleting a user revokes every session.
- Old `convex_auth_token` and `auth_session_token` browser keys are removed. Legacy database sessions are invalid because they have no token digest and are removed when that user next signs in.

The browser storage key is `ecovolt_auth_session_v2`. Do not introduce aliases or duplicate a token across both storage types; that was the cause of the previous “Remember me” persistence failures.

### Browser-storage limitation

Because the current application is a static multi-page SPA that calls Convex directly, JavaScript must be able to read its bearer token. A successful same-origin XSS exploit could therefore steal a remembered token. The application reduces this risk through strict server input validation, Solid's escaped text rendering, explicit output encoding in the vanilla admin UI, short/capped sessions, server-side token hashing, and restrictive response headers.

If the threat model later requires tokens to be unreadable by JavaScript, place authentication behind a same-origin backend-for-frontend and use `HttpOnly; Secure; SameSite=Strict` cookies. Do not switch to JavaScript-created cookies; they do not provide the HttpOnly protection.

## Authorization

Roles are `guest`, `external`, `internal`, and `admin`.

| Feature | Guest | External | Internal | Admin |
|---|:---:|:---:|:---:|:---:|
| Live telemetry | Yes | Yes | Yes | Yes |
| CSV export | No | Limited | Unlimited | Unlimited |
| Historical sessions | No | Recent only | All | All |
| Driver cockpit | No | No | Yes | Yes |
| User administration | No | No | No | Yes |

Administrative rules are enforced in Convex:

- unauthenticated or non-admin callers cannot list or modify users;
- admins cannot change, ban, or delete themselves;
- the final admin cannot be demoted, banned, or deleted;
- banning revokes all target-user sessions;
- rejected access-upgrade requests do not implicitly ban an external account;
- public profile-by-email/user-ID lookups and the old unauthenticated profile-upsert endpoint do not exist.

## XSS and untrusted content

- Never interpolate account fields into `innerHTML`. Solid JSX text expressions escape values automatically; vanilla code must call `escapeHtml` or build nodes with `textContent`.
- Keep validation on the server even when equivalent browser constraints improve feedback.
- Never log passwords, session tokens, complete authentication payloads, or secrets.
- Do not use user-controlled strings as HTML, URLs, CSS, event-handler attributes, selectors, or script source.
- The active historical application contains legacy dynamic HTML and a custom-analysis expression evaluator. Treat changes there as security-sensitive and keep authentication/user data out of those sinks.

## Ably browser access

- Browser code never accepts or embeds an Ably API key. It obtains a one-hour signed token request from the Convex `/ably/token` HTTP action.
- Browser capabilities are limited to `subscribe` and `history` on the dashboard and ESP32 telemetry channels; tokens cannot publish or administer channels.
- Set `ALLOWED_WEB_ORIGINS` in Convex to a comma-separated list of production web origins. When it is unset, CORS remains open for local-development compatibility, although the token is still read-only and channel-scoped.
- Any key that was previously committed or deployed in browser code must be treated as compromised and rotated in Ably after the server-side environment variable is updated.

## Audit and incident response

`authAuditLog` records security event types, timestamps, user references, actor references for admin operations, and one-way email digests where useful. It intentionally contains no passwords, tokens, or raw login payloads.

If compromise is suspected:

1. Delete all `authSessions` rows to force reauthentication.
2. Rotate `AUTH_PASSWORD_PEPPER` only with a forced password-reset or deliberate hash-migration plan; existing peppered hashes cannot be verified without the old value.
3. Rotate the Ably key and update the Convex environment variable.
4. Review `authAuditLog`, Convex logs, Ably activity, and hosting logs.
5. Notify affected users and require password resets when appropriate.

## Deployment checklist

- [ ] `AUTH_PASSWORD_PEPPER` is set in the intended Convex deployment.
- [ ] `ABLY_API_KEY` exists only in Convex environment variables.
- [ ] Previously browser-exposed Ably keys have been rotated.
- [ ] `ALLOWED_WEB_ORIGINS` contains only the intended production origins.
- [ ] No secrets or session tokens appear in frontend configuration, source, logs, or diffs.
- [ ] `npm run typecheck` succeeds.
- [ ] `npx tsc -p convex/tsconfig.json --noEmit` succeeds.
- [ ] `npm run build` succeeds.
- [ ] Sign-up, sign-in with and without “Remember me,” reload, new-tab, sign-out, expiry, and banned-user flows are manually verified.
- [ ] Admin list and mutation functions reject unauthenticated and non-admin callers.
- [ ] Registration XSS payloads render only as text or are rejected.

Last updated: July 2026.
