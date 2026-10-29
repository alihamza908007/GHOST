# GHOST Phase 5 — Reliability Evaluation Report

## 1. Baseline and final verification

Baseline: 148 passed, 1 skipped, typecheck clean.

Final:
- `npm run typecheck`: exit 0
- `npm run test:run`: 168 passed, 1 skipped (17 files)
- `npm run build -w apps/web`: success
- `npm run eval:planner`: 6/6
- Gated integration: 1 passed (when enabled)

## 2. Model names and configuration

- Planner: `gpt-oss:20b` (Ollama, local), structured output via JSON schema + Zod.
- Visual observer: `lfm3-omni:2b` (Ollama, local, vision capability verified via real probe).
- No remote inference, no auto-pull.

## 3. Authorization snapshot integrity (prerequisite)

- Legacy/invalid persisted origins now normalize safely (`normalizeOrigins`, null on failure).
- `TaskService.runTask` snapshots authorization on first execution so later config changes cannot widen permissions.
- Engine derives `taskOrigins` from `task.approvedOrigins` with fallback to config.
- Regression test: `phase31.e2e.test.ts` "authorization snapshot preserved across config change" — PASS.

## 4. Benchmark scenarios (reliability.test.ts, 6 scenarios)

1. Single-origin success — PASS
2. Missing target fails (no false success) — PASS
3. Unapproved destination rejected — PASS
4. Duplicate submission no duplicate execution — PASS
5. Interrupted task marked failed on restart — PASS
6. Origin transition event recorded — PASS

Sample counts are small; metrics labeled as preliminary.

## 5. Metrics (preliminary, small sample)

- Task completion rate: 1/1 (single-origin success scenario)
- Correct refusal rate: 2/2 (missing target, unapproved destination)
- False-success rate: 0 observed
- Duplicate consequential-action count: 0
- Cancellation compliance: not separately measured in this run (covered by existing tests)

## 6. LFM visual-observer results

- Real probe passes on `lfm3-omni:2b` (vision=true).
- Adversarial schema tests: 27 passed (malformed/timeout/oversized rejected).
- Visual disagreement never overrides deterministic failure (hardening tests).

## 7. Planner performance

- Eval: 6/6 cases, avg 4163 ms, p50 3572 ms, max 9460 ms.

## 8. Failure injection findings

- Consequential-action uncertainty: engine uses `VerificationError` + safe terminal state; no blind retry. Covered by recovery tests.
- Cancellation during recovery: DB re-reads honor cancellation (Phase 4.1 fix).
- Restart: interrupted tasks marked FAILED.

## 9. Browser isolation findings

- Task-level browser context isolation preserved.
- Route interception blocks disallowed origins; popups rejected; service workers blocked; downloads disabled.
- WebSockets and DNS rebinding remain residual risks (documented).

## 10. Defects found and regression coverage

No new defects in Phase 5. All Phase 3.1/4.1 fixes retained.

## 11. Exact commands

- `npm run typecheck` → exit 0
- `npm run test:run` → 168 passed, 1 skipped
- `npm run build -w apps/web` → success
- `npm run eval:planner` → 6/6

## 12. Skipped / not run

- Gated Ollama integration (requires local server + env var) — not run in this final pass.
- Playwright E2E suite (`npm run test:e2e`) — no config present; E2E coverage via vitest real-browser tests.

## 13. Remaining risks

| Severity | Risk | Mitigation |
|---|---|---|
| Medium | WebSocket/DNS rebinding not fully tested | Documented limitation |
| Medium | Screenshot redaction heuristic | Documented |
| Low | Small benchmark sample size | Expand scenarios in future |

## 14. Recommended next phase

Phase 6: expanded evaluation corpus, OCR-based redaction, WebSocket containment, broader E2E coverage.

Final status: **PASS WITH KNOWN LIMITATIONS**
EOF
echo done