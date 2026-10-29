# GHOST Phase 4.1 — Multi-Origin Security Audit Report

## 1. Baseline and final test results

Baseline: 148 passed, 1 skipped, typecheck clean.

Final:
- `npm run typecheck`: exit 0
- `npm run test:run`: 161 passed, 1 skipped (16 files)
- `npm run build -w apps/web`: success
- `npm run eval:planner`: 6/6

New tests: `packages/core/test/origin.test.ts` (13).

## 2. Findings

### F-1 — Persisted origin data not validated (Medium) — FIXED
- **Path:** `packages/storage/src/index.ts` `mapTask`.
- **Issue:** `JSON.parse(task.approvedOriginsJson)` could throw or yield unvalidated data, potentially granting broader access.
- **Fix:** parse with try/catch and normalize via `normalizeOrigins`; invalid/empty → null (fail-closed). Legacy null → caller falls back to policy origins.

### F-2 — startTask silently dropped invalid origins (Medium) — FIXED
- **Path:** `apps/server/src/task-service.ts` `startTask`.
- **Issue:** `normalizeOrigins` silently filtered invalid origins, allowing partial valid sets without error.
- **Fix:** strict validation; throw `INVALID_ORIGIN` if any origin fails to normalize.

### F-3 — Restart could broaden authorization (Medium) — FIXED
- **Path:** `runTask` planner context; `mapTask`.
- **Issue:** if persisted origins null, planner received undefined → prompt fallback to single origin, but engine used config origins (potentially different). 
- **Fix:** `runTask` falls back to `this.policy.allowedOrigins` (config) for planner context; engine derives origins from `task.approvedOrigins` when present, else `this.allowedOrigins` (config). Persisted invalid data → null → no task-level override → config set (same as original task creation default). Documented.

### F-4 — isAllowedUrl did not normalize allowed origins (Low) — FIXED
- **Path:** `packages/core/src/policy.ts` `isAllowedUrl`.
- **Issue:** comparing raw allowed origin strings (e.g. `http://example.com:80`) against normalized request origins (`http://example.com`) could mismatch.
- **Fix:** normalize allowed origins via `normalizeOrigins` before comparison.

### F-5 — Browser route handler did not normalize request origin (Low) — FIXED
- **Path:** `packages/engine/src/index.ts` `isAllowedRequestUrl`.
- **Fix:** normalize request origin before membership check.

### F-6 — Engine used config-level origins, not task-level (Medium) — FIXED
- **Path:** `packages/engine/src/index.ts`.
- **Fix:** `taskOrigins` derived from `task.approvedOrigins` with fallback to `this.allowedOrigins`; used in route handler, verification context, recovery.

## 3. Audit results

- Exact-origin enforcement: 13 new tests pass (ports, schemes, subdomains, suffix attacks, credentials, malformed, defaults, IPv4 forms, arrays, dedup, empty).
- Redirects: route handler blocks disallowed; multi-hop chains blocked at first disallowed hop.
- Popups: rejected via `context.on('page')`.
- Cross-origin iframes: route handler applies to all resources including iframe documents.
- WebSockets/downloads: documented residual (Playwright route does not intercept WebSocket; downloads disabled).
- Persistence/restart: `approvedOriginsJson` persisted and reloaded; invalid → null (fail-closed); legacy null → policy fallback.
- Legacy single-origin: `allowedOrigin` getter returns first; used only for backward compat in planner/policy; multi-origin paths use `allowedOrigins`.
- Policy boundaries: planner cannot modify origins (server-side validation); recovery cannot add origins; cancellation/deadlines authoritative; visual cannot authorize.

## 4. Remaining risks

| Severity | Risk | Mitigation |
|---|---|---|
| Medium | WebSocket connections may bypass Playwright route interception | Documented; not in scope of current browser model |
| Medium | DNS rebinding / local-network exposure not separately tested | Documented |
| Low | `allowedOrigin` getter (first origin) used in some compat paths | Tests verify multi-origin paths use `allowedOrigins` |
| Low | Single-node SQLite | Documented |

## 5. Commands

- `npm run typecheck`: exit 0
- `npm run test:run`: 161 passed, 1 skipped
- `npm run build -w apps/web`: success
- `npm run eval:planner`: 6/6

## Final status

**PASS WITH KNOWN LIMITATIONS**
EOF
echo done