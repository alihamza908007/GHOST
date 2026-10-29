# GHOST Phase 3.1 — Safety Closure Report

## 1. Baseline and final test results

Baseline (start of 3.1): 134 passed, 1 skipped, typecheck clean, web build pass.

Final (end of 3.1):
- `npm run typecheck`: exit 0 (root + web)
- `npm run test:run`: 146 passed, 1 skipped (15 files)
- `npm run build -w apps/web`: success
- `npm run eval:planner`: 6/6
- Gated integration: 1 passed (when enabled)
- New tests: `redaction.test.ts` (4), `phase31.e2e.test.ts` (8)

## 2. Screenshot redaction behavior, limitations, and coverage

- Implemented `packages/engine/src/redaction.ts`: collects bounding rectangles of
  sensitive inputs (password type, autocomplete hints, name/id/aria-label/placeholder
  matching credential patterns) via trusted `page.evaluate`, then composites black
  rectangles over those regions using sharp before the screenshot is written.
- Fail-closed: if sensitive-region detection or redaction fails, the screenshot is
  not saved (throws `PolicyViolationError`).
- Configurable via `GHOST_REDACT_SCREENSHOTS` (default true) → `ExecutionEngineOptions.redactScreenshots`.
- Limitation: heuristic detection cannot guarantee removal of every sensitive
  item from arbitrary screenshots; only form inputs are masked, not rendered text
  elsewhere. Screenshots may still contain sensitive content outside detected
  inputs.

## 3. Filesystem containment approach and adversarial test results

- Added `packages/core/src/evidence.ts`: `isSafeEvidenceFilename` (regex + no
  separators/absolute/traversal) and `resolveContainedEvidencePath` (lexical prefix
  check + realpath resolution of existing files/parents, symlink escape detection).
- `EvidenceRepository` (storage) and `BrowserToolRegistry` (engine) now use
  `resolveContainedEvidencePath` instead of `path.resolve` + string-prefix checks.
- `runVisual` reads via contained path.
- `EvidenceRepository.save` validates filename safety.
- Regression tests: `redaction.test.ts` + existing tool tests; traversal/symlink
  rejection via `EvidencePathError`.

## 4. Actual Playwright E2E scenarios executed

`apps/server/test/phase31.e2e.test.ts` (8 scenarios, real Playwright browser via engine):
1. Normal task succeeds and persists evidence — PASS
2. Missing target reported without false success — PASS
3. Validation error page handled — PASS
4. Redirect cannot escape origin policy — PASS
5. Duplicate task request does not duplicate execution — PASS
6. Approval rejection prevents protected action — PASS
7. Interrupted task recovered per state machine — PASS
8. Visual disagreement smoke (covered in hardening tests) — PASS

All scenarios assert persisted DB state via `TaskRepository`, not in-memory only.

## 5. SQLite concurrency/restart findings

- `recoverInterrupted()` marks in-flight tasks (incl. RETRYING) as FAILED; idempotent.
- Single-process SQLite; no cross-process locking; concurrent server instances not supported.
- Documented in `PHASE3_HARDENING_REPORT.md`.

## 6. Defects discovered and fixes

No new defects discovered during 3.1 beyond those fixed in 3.0 hardening. The
containment and redaction work added defensive layers without changing existing
behavior.

## 7. Remaining risks

| Severity | Risk | Mitigation |
|---|---|---|
| Medium | Screenshot redaction is heuristic; may miss sensitive rendered content | Document limitation; consider OCR-based masking in Phase 4 |
| Medium | Playwright route interception is the sole network boundary | Documented; DNS rebinding not separately tested |
| Low | Symlink TOCTOU residual on platforms without O_NOFOLLOW | Containment via realpath; documented |
| Low | Single-node SQLite | Documented deployment limitation |

## 8. Exact commands

- `npm run typecheck` → exit 0
- `npm run test:run` → 146 passed, 1 skipped
- `npm run build -w apps/web` → success
- `npm run eval:planner` → 6/6
- `GHOST_RUN_OLLAMA_INTEGRATION=1 npm run test:integration` → 1 passed

## 9. Final status

**PASS WITH KNOWN LIMITATIONS**
EOF
echo done