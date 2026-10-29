# GHOST — Phase 3: Local Visual Perception and Bounded Recovery

GHOST is a local browser agent. Phase 2 adds a local Ollama planner while keeping
the Phase 1 execution, security, persistence, evidence, and dashboard layers
intact.

The trust boundary is fixed:

```
LLM proposes -> Zod validates -> policy authorizes -> engine executes -> verifier checks -> storage records evidence
```

The model never executes code, never receives browser control, never chooses an
origin outside the configured demo origin, and is never used as the source of
truth for success.

## Features

- **Local structured planning** with Ollama (`gpt-oss:20b` by default), using
  Ollama's JSON-schema `format` and Zod validation of every response.
- **Four supported actions only**: `NAVIGATE`, `CLICK`, `FILL`, `SCREENSHOT`.
  Locators are semantic (`role`, `label`, `testId`); CSS, XPath, and model-written
  JavaScript are rejected.
- **Deterministic policy gate** before planning and again before every action.
- **Independent verification** from the DOM or evidence file, with persisted
  method, outcome, timestamp, and evidence reference.
- **Bounded execution**: at most 8 planned steps, 15 executed actions, 2 planner
  attempts, bounded request/response size, and per-request timeouts.
- **Approval workflow** for sensitive `FILL` fields and high-consequence clicks:
  approve, reject, revalidate, and resume the original browser session.
- **Ordered, durable history**: tasks, events, approvals, and evidence survive
  server restarts; duplicate concurrent execution is prevented.
- **Dashboard** for objectives, model health, plans, progress, verification,
  approvals, errors, screenshots, and history. Fill values are redacted by the API.
- **Planner evaluation** with six reproducible cases, including ambiguous
  objectives, unexpected origins, step budgets, and page prompt injection.

## Prerequisites

- Node.js 18+ and npm
- Playwright Chromium (`npx playwright install chromium` if not already present)
- A local [Ollama](https://ollama.com) server

### Model requirement

Phase 2 uses exactly the locally installed tag configured by
`OLLAMA_PLANNER_MODEL` (default `gpt-oss:20b`). GHOST **never pulls or downloads
a model** and refuses remote inference.

```bash
ollama list
ollama pull gpt-oss:20b   # manual, only if you choose to install it
npm run probe:ollama
```

The probe verifies connection, model availability, text generation, structured
output, and vision capability. `gpt-oss:20b` supports structured output and does
**not** advertise vision, so Phase 2 uses DOM/text verification only.
`lfm3-omni:2b` is not part of the mandatory path.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Generate Prisma Client and apply migrations**

   ```bash
   npx prisma generate
   npx prisma migrate deploy
   ```

   `migrate deploy` applies the Phase 2 schema and the one-time normalization of
   legacy Phase 1 `Task.createdAt` / `Task.updatedAt` values, so history ordering
   is correct.

3. **Optional configuration**

   Copy `.env.example` to `.env` if you need non-default ports or origins. Every
   value is optional; existing process env wins over `.env`.

4. **Start the demo target** (terminal 1)

   ```bash
   node demo_target.js
   # http://127.0.0.1:3001
   ```

5. **Start the GHOST server** (terminal 2)

   ```bash
   npm run dev:server
   # http://localhost:3002
   ```

6. **Start the dashboard** (terminal 3)

   ```bash
   npm run dev:web
   # http://localhost:3000
   ```

Open `http://localhost:3000`, enter an objective, and start a task. Example:

- `Open the GHOST demo application, click the Show message button, and capture a screenshot.`
- `Open the GHOST demo application, fill the Email field with demo@example.com, click Sign in, and capture a screenshot.`

The second example pauses for approval because `Email` matches the sensitive
field policy. The API returns `[redacted]` for the value; approving resumes the
same live browser session, rejecting cancels the task without executing the
`FILL`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Loopback-only Ollama endpoint |
| `OLLAMA_PLANNER_MODEL` | `gpt-oss:20b` | Exact local planner tag |
| `OLLAMA_TIMEOUT_MS` | `45000` | Planner request timeout |
| `GHOST_DEMO_ORIGIN` | `http://127.0.0.1:3001` | Exact allowed origin |
| `GHOST_PORT` | `3002` | API port |
| `GHOST_DASHBOARD_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | CORS allowlist |
| `GHOST_EXECUTION_TIMEOUT_MS` | `120000` | Whole-task execution timeout |
| `GHOST_ACTION_TIMEOUT_MS` | `15000` | Per-action timeout |
| `GHOST_MODEL_PROBE_CACHE_MS` | `60000` | Model health cache |
| `EVIDENCE_DIR` | `./evidence_store` | Screenshot storage |
| `NEXT_PUBLIC_GHOST_API_URL` | `http://localhost:3002` | Dashboard API base |
| `GHOST_RUN_OLLAMA_INTEGRATION` | unset | Opt in to the real-model test |

Ollama URLs are restricted to loopback hosts. `GHOST_DEMO_ORIGIN` is compared by
exact scheme, host, and port.

## Commands

```bash
npm run dev:server          # API on :3002
npm run dev:web             # dashboard on :3000
npm run test:run            # deterministic unit/integration suite
npm run test:integration    # opt-in real gpt-oss:20b test
npm run typecheck           # server + web TypeScript
npm run probe:ollama        # model capability verification
npm run eval:planner        # six-case planner evaluation
npm run prisma:generate
npm run prisma:migrate
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server phase, allowed origin, planner model |
| `GET` | `/health/model` | Cached Ollama capability snapshot |
| `POST` | `/tasks/start` | Plan and execute an objective (`{ objective }`) |
| `GET` | `/tasks` | Newest-first task history |
| `GET` | `/tasks/:id` | Task, plan (redacted), and pending approval |
| `GET` | `/tasks/:id/events` | Ordered events (`seq`, `type`, `timestamp`, `data`) |
| `GET` | `/tasks/:id/approval` | Pending approval (redacted) |
| `POST` | `/tasks/:id/approval` | `{ decision: "approve" \| "reject", approvalId }` |
| `POST` | `/tasks/:id/cancel` | Cancel a running or awaiting task |
| `GET` | `/tasks/:id/screenshot-url` | Evidence URL for the last screenshot |

## Security model

- **Exact-origin navigation.** Navigation and every browser request must stay on
  the configured demo origin. Redirects, unexpected subresources, and popups are
  blocked and recorded as `POLICY_REJECTION`.
- **No remote inference.** Only loopback Ollama URLs are accepted.
- **No model-download side effects.** GHOST checks the exact configured tag and
  fails safely if it is absent.
- **No model-authored code.** There is no `evaluate`/`EXECUTE_JS` action; unknown
  actions fail schema validation.
- **Bounded output and input.** Model output is size-limited and schema-checked.
  Observations are untrusted text and are delimited in the prompt.
- **Deterministic policy.** Budgets, origins, expectation/action compatibility,
  screenshot coverage, and weak click postconditions are checked in code.
- **Approval revalidation.** After an approval decision, the action schema and
  policy are revalidated before execution; an approval cannot authorize a changed
  action.
- **No success from model claims.** A task is complete only after independent
  DOM/evidence verification of every step.

## Verification semantics

| Action | Allowed expectation |
| --- | --- |
| `NAVIGATE` | `url`, `visibleText`, `elementVisible` |
| `CLICK` | `url`, `visibleText`, `elementVisible` (a real postcondition) |
| `FILL` | `fieldValue`, `visibleText`, `elementVisible` |
| `SCREENSHOT` | `screenshot` |

Every verification result is persisted with `method`, `outcome`, `timestamp`, and
`evidenceRef`. A click whose expectation was already true before the click is
reported as `inconclusive`, not `passed`. A plan that drops a screenshot requested
by the objective is rejected (`MISSING_REQUIRED_SCREENSHOT`), and a click whose
expectation merely restates the clicked control is rejected
(`WEAK_CLICK_POSTCONDITION`).

## Tests and measured results

Deterministic suite (mocked model, CI-safe):

- **60 passed, 1 skipped** across 9 files
- The skipped test is the opt-in real-model integration test
- `npx tsc --noEmit` and `npx tsc --noEmit -p apps/web` both pass

Real local-model checks (this machine, Ollama 0.40.12, `gpt-oss:20b`):

- **Probe:** connected, model available, text generation, structured output
  `true`; vision `false`.
- **Planner eval:** **6/6** cases pass; average latency **4189 ms**, p50
  **3565 ms**, max **9635 ms**. Safe rejection for ambiguous, unapproved-origin,
  and over-budget objectives; the injected-page case produced only a plan on the
  approved origin.
- **Real end-to-end, no approval:** 3 steps (`NAVIGATE` → `CLICK` → `SCREENSHOT`),
  3/3 verifications passed, 40 KB PNG evidence.
- **Real end-to-end with approval:** paused at a sensitive `FILL`, API redacted
  the value, approval resumed the same session, 4/4 verifications passed, 44 KB
  PNG evidence.
- **Real rejection:** task moved to `CANCELLED`; `APPROVAL_REJECTED` recorded and
  no `FILL` action executed.
- **Restart persistence:** completed tasks retained status, plan, ordered events,
  approvals, and evidence; history lists newest first.

## Known limitations and deferred Phase 4

See `PHASE3_REPORT.md` for the Phase 3 completion report and testing plan.
Phase 4 (voice/audio/video, multi-origin, desktop control, multi-agent) is
intentionally not implemented.

- Verification is DOM/evidence-based only; there is no visual model judgment.
- The planner supports four actions and a single demo origin; multi-site and
  authenticated flows are out of scope.
- Approval is a narrow human-in-the-loop gate, not a full RBAC/identity system.
- SQLite and local filesystem storage are single-node only.
- No autonomous recovery/replanning loop after a verification failure; failures
  are recorded and surfaced.
- Browser sessions are kept in memory while awaiting approval; a server restart
  marks interrupted tasks failed.
- Phase 3 features (richer action set, visual verification, multi-origin policy,
  distributed storage, deeper evaluation) are intentionally not implemented.
