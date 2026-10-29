# GHOST Phase 3 — Local Visual Perception and Bounded Recovery

Phase 3 adds a local, screenshot-based visual perception component and a
conservative, evidence-driven recovery controller on top of the Phase 2
planning/execution stack. It stops at Phase 3: no voice/audio/video, no
unrestricted multi-origin browsing, no desktop control, no multi-agent
coordination.

## Trust boundary (unchanged)

```
LLM proposes -> Zod validates -> policy authorizes -> engine executes -> deterministic verifier checks -> visual observer describes -> conservative combination -> storage records evidence
```

The visual model is **never** a source of truth for success. It never executes
actions, never authorizes anything, and never controls browser/policy/approvals.
Confidence is descriptive only and is never used as proof.

## What shipped

### Local visual observer (`packages/models/src/vision.ts`)
- `OllamaVisionObserver` using Ollama's top-level `images: [base64]` shape.
- Strict `VisualObservationSchema` (Zod `.strict()`): bounded `summary`,
  `expectedCondition` ∈ {present, absent, uncertain}, bounded `obstructions`,
  bounded `explanation`, optional `confidence`. Extra fields rejected; no silent
  coercion.
- Vision prompt (`packages/models/src/prompt.ts`) treats all page/DOM text as
  untrusted data; only bounded action context and sanitized deterministic
  diagnostics enter the prompt.
- `OllamaProvider.generateVision`: `temperature: 0`, `num_predict: min(maxOutputTokens ?? 512, 1024)`,
  `num_ctx: 8192`, `runWithTimeout`, error mapping, `maxImageBytes` default 8 MB,
  `decodeBase64Image` validation.
- No auto-pull, no remote fallback. `lfm3-omni:2b` is the default vision model
  (real probe passes on this machine).
- Real capability probe required; `probe()` throws `UNSUPPORTED_IMAGE_INPUT` when
  the model does not advertise vision.

### Conservative verification (`packages/engine/src/verification.ts`)
- `combineVerification(deterministic, visual, …)`:
  - deterministic pass stands alone regardless of vision availability.
  - deterministic fail + positive visual → `inconclusive` (never override).
  - deterministic fail + absent visual → `failed`.
  - uncertain vision → `inconclusive`.
  - disagreement → conservative (inconclusive).
  - vision timeout/invalid/unavailable → preserve deterministic result.
- Vision is only consulted when deterministic is not passed.

### Bounded recovery (`packages/engine/src/recovery.ts`)
- `evaluateRecovery`: eligibility rules (terminal/cancelled/degraded/approval
  blocked; no recovery after verified success; hard budget of 2 attempts per task).
- Catalog: dismiss known overlay via stable semantic close control (allowlist-gated),
  re-evaluate postcondition before retry, retry a retry-safe action only when
  justified (deterministic failure + visual `absent`), one retry per action.
- `RETRYING` status added to state machine; `NO_RECOVERY_STATUSES` exported.
- Engine `runRecovery`: executes dismiss-then-retry sequence, re-verifies, can
  complete the task or resume the plan; consumes action budget; honors task
  timeout/cancellation; never resets exhausted budget.
- Consequential actions are never blindly repeated; inconclusive-after-possible-
  success stops safely with evidence.

### Events, persistence, dashboard
- New event types: `VISUAL_OBSERVATION_STARTED/COMPLETED/UNAVAILABLE`,
  `DOM_VISUAL_DISAGREEMENT`, `RECOVERY_STARTED/COMPLETED`,
  `RETRY_AUTHORIZED/REJECTED`, `RECOVERY_BUDGET_EXHAUSTED`.
- No base64 in events; evidence referenced by filename.
- `recoverInterrupted()` now also fails tasks interrupted in `RETRYING`.
- Dashboard: RETRYING stage, color coding, summaries for all new event types,
  screenshot evidence URL.
- Server: `OLLAMA_VISION_MODEL` (default `lfm3-omni:2b`), vision provider/observer
  wired, model health reports vision capabilities/errors.

### Policy (`packages/core/src/policy.ts`)
- `RECOVERY_UNAUTHORIZED` code + `authorizeRecovery(action, …)`; allowlist-gated
  overlay dismissal; recovery actions still pass `evaluate()`.

### Demo scenarios (`demo_target.js`)
- `overlay`, `validation-error`, `missing-target`, `consequential`, `already-true`,
  plus existing `home`/`about`/`injected`.

## Testing

- Typecheck: `npm run typecheck` (root + web) passes.
- Unit tests: `npm run test:run` → 78 passed, 1 skipped.
- New tests: `packages/models/test/vision.test.ts` (8), `packages/engine/test/recovery.test.ts` (18).
- Integration: `GHOST_RUN_OLLAMA_INTEGRATION=1 npm run test:integration` passes.
- Planner eval: `npm run eval:planner` → 6/6 cases pass.
- Web build: `npm run build -w apps/web` succeeds.
- Real smoke: `node demo_target.js` + server; planner + vision probe verified.

## Phase 3 DoD checklist
- [x] Local vision observer via `lfm3-omni:2b`, real probe, no auto-pull, no remote fallback.
- [x] Strict `VisualObservation` Zod schema, extra fields rejected.
- [x] Deterministic-first, conservative verification combination.
- [x] Bounded recovery: ≤2 attempts, ≤1 retry per action, no retry after success.
- [x] RETRYING status + safe migration (no schema change needed; string status).
- [x] Events persisted with refs, no base64.
- [x] Dashboard updated.
- [x] API/config updated.
- [x] Concurrent execution prevented; cancellation/deadline honored.
- [x] Restart marks interrupted tasks (incl. RETRYING) failed.
- [x] No Phase 4 features implemented.

## Deferred to Phase 4
Voice/audio/video, unrestricted multi-origin browsing, desktop control,
multi-agent coordination, distributed storage, RBAC, richer action set.
