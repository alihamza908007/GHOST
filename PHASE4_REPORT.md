# GHOST Phase 4 — Controlled Multi-Origin Browser Automation Report

## 1. Architecture changes

- `ActionPolicy` now carries `allowedOrigins: string[]` (plus legacy `allowedOrigin` getter for the first origin). Constructor normalizes and deduplicates origins; requires at least one.
- New `normalizeOrigin` / `normalizeOrigins` helpers in `@ghost/core` (exact scheme+host+port, rejects credentials and unsupported schemes).
- `isAllowedUrl(url, allowedOrigins)` accepts `string | string[]`.
- Engine stores `allowedOrigins` (from options/policy) and uses it in the browser route handler, verification context, and recovery.
- `Task` gains `approvedOrigins?: string[] | null`, persisted via `approvedOriginsJson` column (migration `20261029130214_phase4_multi_origin`).
- `TaskService.startTask(objective, approvedOrigins?)` normalizes/validates origins; defaults to configured set.
- API `/tasks/start` accepts optional `approvedOrigins: string[]`.
- Planner context gains `approvedOrigins`; prompt lists all approved origins.
- Browser context route handler checks origin membership in `allowedOrigins`.
- Dashboard shows approved origins and `ORIGIN_TRANSITION` events.

## 2. New origin authorization model

- Explicit allowlist of origins (scheme+host+port). No subdomain/sibling auto-authorization, no hostname substring matching.
- Planner cannot expand the set; task authorization persisted and reloaded on restart.
- Every navigation and redirect checked against the set at the network boundary.

## 3. API changes and compatibility

- `POST /tasks/start` body: `{ objective?, approvedOrigins? }`. Backward compatible (origin defaults to configured approved set).
- `GET /tasks/:id` returns `approvedOrigins`.

## 4. Browser navigation enforcement

- `context.route('**/*')` checks `allowedOrigins.includes(origin)`.
- `data:`/`blob:`/`about:` restricted to subresources (H-3 from Phase 3.1).
- Popups rejected; service workers blocked; downloads disabled.

## 5. Redirect behavior

- Redirects followed by browser; route handler blocks disallowed destinations; verification re-checks origin via `isAllowedUrl`.

## 6. Planner changes

- Prompt lists approved origins; instructs model to navigate only within them.
- `allowedOrigins` passed from policy.

## 7. Policy changes

- `ActionPolicy.allowedOrigins` replaces single-origin assumption; `allowedOrigin` getter returns first for compat.
- `validatePlan` checks navigations against `allowedOrigins`.
- `authorizeRecovery` uses `allowedOrigins`.

## 8. Verification behavior

- `VerificationContext` carries `allowedOrigin` + optional `allowedOrigins`; `isAllowedUrl` normalizes.
- Visual verification unchanged (conservative).

## 9. Recovery behavior

- Recovery does not introduce new origins; retries existing actions only.

## 10. Persistence and migrations

- Added `approvedOriginsJson` column to Task (nullable, backward compatible).
- Migration created and applied.

## 11. Dashboard changes

- Shows approved origins; renders `ORIGIN_TRANSITION` events.

## 12. Demo scenarios

- Multi-origin E2E test uses two local demo servers on different ports.

## 13. Exact commands executed

- `npm run typecheck` → exit 0
- `npm run test:run` → 148 passed, 1 skipped (15 files)
- `npm run build -w apps/web` → success
- `npm run eval:planner` → 6/6
- Phase 3.1 E2E: 10 passed

## 14. Results

- Unit: 148 passed, 1 skipped
- Integration (gated): 1 passed
- E2E (phase31): 10 passed
- Typecheck: clean

## 15. Security findings

- Origin membership enforced at network boundary and policy.
- No hostname substring matching; exact origin equality.
- Credentials in URLs rejected by `normalizeOrigin`.
- Planner cannot expand permissions (validated server-side).

## 16. Known limitations

- Browser route interception is the network boundary; DNS rebinding not separately tested.
- Subresource (image/font) requests to approved origins only; third-party subresources on approved pages blocked.
- No automated login/MFA; cookies stay within isolated context.
- Single-node SQLite.

## 17. Deferred capabilities

Desktop automation, voice/audio/video, multi-agent, remote inference, public deployment (out of scope).

## 18. Recommended next phase

Phase 5: deeper evaluation, hardened browser profile isolation, optional OCR-based evidence redaction.

Final status: **PASS WITH KNOWN LIMITATIONS**
EOF
echo done