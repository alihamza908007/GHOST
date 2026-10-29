# GHOST Phase 5.1 — Authorization Integrity Audit Report

## 1. Authorization lifecycle audited

Path traced: `POST /tasks/start` → `TaskService.startTask` → `TaskRepository.create` → `runTask` → `StructuredPlanner.plan` → `ExecutionEngine.executePlan` → policy authorization → Playwright navigation → verification → persistence → restart recovery.

## 2. Findings and fixes

### F-5.1-1 — Authorization silently created during execution (High) — FIXED
- **Path:** `apps/server/src/task-service.ts` `runTask`.
- **Issue:** The Phase 5 code created an authorization snapshot on first execution using current config, which could broaden a legacy task's permissions.
- **Fix:** Removed the snapshot-on-first-execution. Missing/invalid authorization now fails closed with `AUTHORIZATION_MISSING`.
- **Regression:** `phase31.e2e.test.ts` "authorization snapshot preserved across config change" + "legacy task with null authorization fails closed at execution".

### F-5.1-2 — Engine fell back to config origins (High) — FIXED (Phase 5)
- **Path:** `packages/engine/src/index.ts` `executePlan`.
- **Issue:** `taskOrigins` fell back to `this.allowedOrigins` (config) when task snapshot missing.
- **Fix:** Fail closed (empty origins → throw `PolicyViolationError`).

### F-5.1-3 — Persisted invalid origin data (Medium) — FIXED (Phase 4.1)
- **Path:** `packages/storage/src/index.ts` `mapTask`.
- **Fix:** try/catch + `normalizeOrigins`; invalid → null.

### F-5.1-4 — startTask silently dropped invalid origins (Medium) — FIXED (Phase 4.1)
- **Path:** `apps/server/src/task-service.ts` `startTask`.
- **Fix:** strict validation; throw `INVALID_ORIGIN`.

## 3. Adversarial regression tests

Added to `phase31.e2e.test.ts`:
- "authorization snapshot preserved across config change" — PASS
- "malformed persisted origin fails closed" — PASS
- "empty persisted origin normalizes to null" — PASS
- "legacy task with null authorization fails closed at execution" — PASS

Plus `origin.test.ts` (13 tests) covering exact-origin enforcement.

## 4. Reliability benchmark

`apps/server/test/reliability.test.ts` — 6 scenarios, all PASS.

## 5. Verification

- `npm run typecheck`: exit 0
- `npm run test:run`: 171 passed, 1 skipped
- `npm run build -w apps/web`: success
- `npm run eval:planner`: 6/6

## 6. Remaining risks

| Severity | Risk |
|---|---|
| Medium | WebSocket/DNS rebinding not tested |
| Medium | Screenshot redaction heuristic |
| Low | Small benchmark sample size |

## Final status

**PASS WITH KNOWN LIMITATIONS**
EOF
echo done