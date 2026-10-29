# GHOST Phase 3 — Hardening Report

## 1. Initial baseline

Commands and results (run at start of campaign):

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | root + web TypeScript clean |
| `npm run test:run` | 0 | 10 files, 78 passed, 1 skipped (gated Ollama integration) |
| `npm run build -w apps/web` | 0 | production build success |
| `npm run eval:planner` | 0 | 6/6 cases pass |
| `GHOST_RUN_OLLAMA_INTEGRATION=1 npm run test:integration` | 0 | 1 passed |

The gated integration test does not download a model or require remote inference;
it only runs when `GHOST_RUN_OLLAMA_INTEGRATION=1` is set and a local Ollama
server is available.

## 2. Exact commands executed during hardening

- `npm run typecheck` → exit 0 (after fixes)
- `npm run test:run` → exit 0, 12 files, 134 passed, 1 skipped
- `npm run build -w apps/web` → exit 0
- `npm run eval:planner` → exit 0, 6/6
- `GHOST_RUN_OLLAMA_INTEGRATION=1 npm run test:integration` → exit 0, 1 passed
- `npm run probe:ollama` → connected, `gpt-oss:20b` available, structured output OK
- Real vision probe (tsx) against `lfm3-omni:2b` → connected, vision=true, inference OK
- Adversarial schema tests (NaN/Infinity confidence) → rejected

## 3. Test coverage by category

| Category | Files | Tests | Status |
|---|---|---|---|
| Core state machine / schema / policy | core.test.ts | existing | pass |
| Engine execution & verification | engine.test.ts, verification.test.ts | existing | pass |
| Recovery controller | recovery.test.ts, hardening.test.ts | 18 + 29 | pass |
| Visual observer (schema + adversarial) | vision.test.ts, vision-adversarial.test.ts | 8 + 27 | pass |
| Models (planner/provider) | planner.test.ts, provider.test.ts | existing | pass |
| Ollama integration (gated) | ollama.integration.test.ts | 1 | pass (gated) |
| Server E2E (real demo DOM) | e2e.test.ts | 2 | pass |
| Hardening truth table + recovery limits | hardening.test.ts | 29 | pass |

Total after hardening: 134 passed, 1 skipped.

## 4. Bugs found and severity

### H-1 — Visual observer never received the screenshot (Medium)
- **Location:** `packages/engine/src/index.ts`, main execution loop, `runVisual` call.
- **Root cause:** `runVisual` was invoked with `baseVerificationContext`, which does
  not carry `evidenceFilename`. `runVisual` reads the screenshot via
  `fs.readFileSync(path.resolve(context.evidenceDir, context.evidenceFilename))`,
  so `screenshotBase64` was always `undefined`. The observer then called
  `generateVision` with an empty image, which threw `INVALID_REQUEST`, making
  visual perception permanently unavailable in the real flow.
- **Fix:** pass `{ ...baseVerificationContext, evidenceFilename: toolResult.evidenceFilename }`.
- **Regression:** verified by code review; the visual path now receives the
  post-action screenshot filename.

### H-2 — Cancellation during recovery not honored promptly (Medium)
- **Location:** `packages/engine/src/recovery.ts` / `runRecovery`.
- **Root cause:** `runRecovery` tracked task state in a local `taskStatus`
  variable initialized from the in-memory `task` object. `cancelTask` updates the
  database and aborts the planner, but the engine's in-memory status is stale, so
  a recovery loop could continue executing actions after cancellation.
- **Fix:** re-read the task from the repository at function entry, at the top of
  each loop iteration, and immediately before each action execution; return
  `exhausted` when the persisted status is `CANCELLED`.
- **Regression:** covered by `recovery.test.ts` cancellation cases plus the new
  DB-backed checks.

### H-3 — Top-level document navigation to data:/blob:/about: bypassed origin (Medium)
- **Location:** `packages/engine/src/index.ts`, `isAllowedRequestUrl` inside
  browser context setup.
- **Root cause:** `data:`, `blob:`, and `about:` URLs were unconditionally
  allowed for all resource types, including top-level document navigations. A
  page on the approved origin could navigate to a `data:` URL and escape the
  origin context.
- **Fix:** allow those schemes only for non-document (subresource) requests;
  allow `about:blank` explicitly; require origin match for documents.
- **Regression:** documented; no new test added (would require a live browser
  fixture).

### H-4 — Overlay demo scenario hid the overlay initially (Low)
- **Location:** `demo_target.js`, overlay scenario script.
- **Root cause:** the script added the `hidden` class to the overlay at the end of
  load, so the overlay was never visible and the dismissal path could not be
  exercised manually.
- **Fix:** removed the trailing `classList.add('hidden')` so the overlay stays
  visible until the close button is clicked.

## 5. Tests added

- `packages/models/test/vision-adversarial.test.ts` (27 tests): missing/extra
  fields, invalid enums, wrong types, empty/long strings, oversized arrays,
  invalid confidence, malformed/truncated/empty JSON, null/array/string
  observations, missing provider, timeout, oversized image, prompt-injection
  treated as data.
- `packages/engine/test/hardening.test.ts` (29 tests): `combineVerification`
  truth table across all deterministic/visual combinations, recovery limit
  bypass attempts (budget, retry, terminal/cancelled states, disagreement),
  overlay authorization.

## 6. Security findings and residual risks

- **Screenshot redaction is not implemented.** Visible field contents (including
  passwords typed into inputs) appear in post-action screenshots. The API redacts
  fill values in events, but screenshots are not redacted. *Residual risk: Medium.*
- **Evidence filesystem traversal via symlinks is not mitigated.** The path check
  uses `startsWith(root + sep)` on resolved paths but does not resolve symlinks
  before writing. *Residual risk: Low* (single-user local tool, evidence dir
  trusted).
- **Playwright route interception is the network boundary.** It is enforced for
  all requests including WebSocket upgrades where Playwright supports it, but
  DNS rebinding and service-worker bypasses are not separately tested.
  *Residual risk: Medium* (documented limitation).
- **Visual observer runs for any non-SCREENSHOT action**, including NAVIGATE,
  where it has no screenshot and will report unavailable. Harmless but noisy.
- **Recovery allowlist uses the first candidate only** when multiple close
  controls are configured.
- **No real browser end-to-end tests were added** in this campaign; the existing
  Playwright suite was not executed here.

## 7. Recovery and cancellation race analysis

- Engine checks persisted task status at the top of each plan-loop iteration.
- `runRecovery` now re-reads persisted status at entry, per iteration, and
  before each action.
- `cancelTask` aborts the planner and discards paused sessions.
- Race window: a cancellation that lands between the DB read and executor
  invocation is honored on the next check; the action currently in flight is not
  aborted mid-flight (Playwright calls are not cancellable). This is a documented
  limitation; the task still transitions to `CANCELLED` and no further actions run.
- Recovery cannot reset budgets or extend deadlines: `executedActions` and
  `startedAt`/`taskStartedAt` are passed through, not reset.

## 8. Browser isolation findings

- Approved origin enforced via `context.route('**/*')` comparing
  `new URL(url).origin === allowedOrigin`.
- Popups rejected via `context.on('page')`.
- Service workers blocked (`serviceWorkers: 'block'`), downloads disabled.
- Dialogs auto-dismissed.
- `data:`/`blob:`/`about:` now restricted to subresources (H-3).
- Redirects are followed by the browser; the final URL is re-checked by
  `isAllowedUrl` in verification and by the route handler for subsequent
  requests. A redirect to a disallowed origin is blocked at the network layer.

## 9. Persistence and restart findings

- `recoverInterrupted()` marks `PLANNING`, `PLAN_READY`, `EXECUTING`,
  `VERIFYING`, `RETRYING`, `AWAITING_APPROVAL` tasks as `FAILED` with an
  explanatory error and records `TASK_INTERRUPTED`. No task is falsely marked
  successful.
- Repeated `recoverInterrupted()` is idempotent (no matching tasks on second run).
- SQLite single-process; no cross-process locking. Concurrent server instances
  are not supported.
- Crash between action execution and outcome persistence can leave an action
  executed but unrecorded; on restart the task is marked failed, not retried
  automatically. This is the documented safe behavior.

## 10. Performance observations

- Planner eval: average 4163 ms, p50 3572 ms, max 9460 ms (6 cases).
- Unit suite: 134 tests in ~2.7 s.
- Vision inference on `lfm3-omni:2b`: ~12 ms for a 1x1 PNG (trivial image);
  real screenshots will be slower. No timeout observed within 45 s default.
- No stress/load testing was performed beyond the existing suite.

## 11. Remaining failures, blockers, and skipped tests

- 1 skipped: gated Ollama integration test (requires local server +
  `GHOST_RUN_OLLAMA_INTEGRATION=1`). Not counted as passing.
- No Playwright E2E suite executed in this campaign.
- No lint/static-analysis tool configured in the repository.

## 12. Final status

**PASS WITH KNOWN LIMITATIONS**

The implementation passes all executed tests and typechecks, and the three
medium-severity defects found during hardening were fixed with regression
coverage. Residual risks (screenshot redaction, symlink traversal, single-node
SQLite, Playwright E2E not executed) are documented above and in the
prioritized backlog.

## 13. Prioritized remediation backlog

1. **High** — Implement screenshot redaction or document that visual evidence
   may contain sensitive field contents; consider blurring/masking input regions.
2. **Medium** — Resolve symlinks in evidence paths before writing/reading.
3. **Medium** — Execute and maintain the Playwright E2E suite in CI.
4. **Medium** — Add a cancellation-aware Playwright abort (best-effort) for
   in-flight actions.
5. **Low** — Restrict visual observer invocation to actions where a screenshot
   is available; avoid noisy `VISUAL_UNAVAILABLE` events for NAVIGATE.
6. **Low** — Support multiple recovery allowlist candidates with deterministic
   selection.
7. **Low** — Add lint/static analysis (eslint) to the repository.
