# GHOST — Local-First Browser Agent

GHOST is a local-first browser automation agent. It accepts a natural-language goal, plans a workflow using a local Ollama model, executes permitted browser actions through a controlled Playwright engine, verifies outcomes independently, recovers from reasonable failures, and presents results with evidence.

**Trust boundary:** `LLM proposes → Zod validates → policy authorizes → engine executes → verifier checks → storage records evidence`

The model never executes code, never receives browser control, never chooses an origin outside the configured approved set, and is never the source of truth for success.

## Features

- **Local structured planning** with Ollama (`gpt-oss:20b` by default).
- **Adaptive observe-plan-act-verify loop** with bounded replanning (max 3 iterations).
- **Four supported actions:** `NAVIGATE`, `CLICK`, `FILL`, `SCREENSHOT`. Semantic locators only (role, label, testId). No CSS/XPath/JS.
- **Multi-origin authorization:** task-specific approved origin sets, immutable after creation.
- **Deterministic policy gate** before planning and before every action.
- **Independent verification** from the DOM/evidence, plus conservative visual observation (`lfm3-omni:2b`).
- **Bounded recovery:** max 2 attempts/task, max 1 retry/action, no blind retries of consequential actions.
- **Approval workflow** for sensitive FILL fields and high-consequence clicks.
- **Research mode:** multi-page structured extraction with CSV/JSON export.
- **Reusable skills:** save verified workflows, execute with different inputs; one-click parameterization from any completed task.
- **Autonomous skill creation:** completed task plans are converted into parameterized skills automatically (`POST /tasks/:id/skill`).
- **Screenshot redaction** for sensitive inputs (fail-closed).
- **Evidence filesystem containment** (path traversal + symlink escape protection).
- **Dashboard:** task submission, live progress, plan, timeline, evidence, approvals, skills, research.
- **Persistence:** tasks, events, approvals, evidence survive restarts.

## Prerequisites

- Node.js 18+ and npm
- Playwright Chromium (`npx playwright install chromium`)
- Local [Ollama](https://ollama.com) server

### Models

```bash
ollama pull gpt-oss:20b        # planner (required)
ollama pull lfm3-omni:2b      # visual observer (optional, for visual verification)
npm run probe:ollama
```

GHOST never pulls or downloads models automatically and refuses remote inference.

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

3. **Start the demo target**
   ```bash
   node demo_target.js
   ```

4. **Start the server**
   ```bash
   npm run dev:server
   ```

5. **Start the dashboard**
   ```bash
   npm run dev:web
   ```
   Open http://localhost:3000

## Configuration

Environment variables (via `.env` or process env):

| Variable | Default | Description |
|---|---|---|
| `GHOST_PORT` | 3002 | Server port |
| `GHOST_DEMO_ORIGIN` | http://127.0.0.1:3001 | Primary demo origin |
| `GHOST_APPROVED_ORIGINS` | (demo origin) | Comma-separated approved origins |
| `OLLAMA_BASE_URL` | http://127.0.0.1:11434 | Ollama server URL |
| `OLLAMA_PLANNER_MODEL` | gpt-oss:20b | Planner model tag |
| `OLLAMA_VISION_MODEL` | lfm3-omni:2b | Visual observer model tag |
| `OLLAMA_TIMEOUT_MS` | 45000 | Model request timeout |
| `GHOST_EXECUTION_TIMEOUT_MS` | 120000 | Task execution timeout |
| `GHOST_ACTION_TIMEOUT_MS` | 15000 | Per-action timeout |
| `GHOST_REDACT_SCREENSHOTS` | true | Screenshot redaction |
| `EVIDENCE_DIR` | ./evidence_store | Evidence storage path |

## Usage

1. Open the dashboard at http://localhost:3000.
2. Enter a natural-language objective.
3. Optionally specify approved origins (comma-separated).
4. Click "Plan & Run".
5. Watch progress, approve/reject actions, view evidence.
6. For research: use the Research panel with objective, origins, and fields (JSON).
7. For skills: save a completed workflow as a skill, then run it with different inputs.
   Or create a skill manually from inputs and steps in the Skills panel (guided step builder).
   Or let GHOST convert a completed task into a parameterized skill automatically.

## Commands

| Command | Description |
|---|---|
| `npm run dev:server` | Start API server |
| `npm run dev:web` | Start dashboard |
| `npm run test:run` | Run unit/integration tests |
| `npm run typecheck` | TypeScript check (root + web) |
| `npm run build -w apps/web` | Production web build |
| `npm run eval:planner` | Planner evaluation (6 cases) |
| `npm run probe:ollama` | Probe Ollama models |

## API

| Method & path | Purpose |
|---|---|
| `GET /health` | Server + allowed demo origin status |
| `GET /health/model` | Local model capabilities / health |
| `POST /tasks/start` | Start a task (objective + approved origins) |
| `GET /tasks` / `GET /tasks/:id` / `GET /tasks/:id/events` | Task lists, detail, timeline |
| `POST /tasks/:id/approval` | Approve / reject a pending action |
| `POST /tasks/:id/cancel` | Cancel a running task |
| `GET /tasks/:id/screenshot-url` | Latest verified screenshot evidence URL |
| `POST /tasks/:id/skill` | Save a completed task as a parameterized skill (auto-detects inputs) |
| `GET /skills` / `POST /skills` | List / create skills (validated definitions) |
| `GET /skills/:id/runs` | Skill run history (reconciled with task status) |
| `POST /skills/:id/run` | Run a skill with inputs (validates required, types, lengths, placeholders) |
| `POST /research` | Start research task (objective, origins, fields, page budget) |

## Known limitations

- WebSocket/DNS-rebinding not mitigated (Playwright route interception only).
- Screenshot redaction is heuristic (password inputs masked).
- Single-node SQLite (no multi-instance).
- No Playwright Test config (E2E via vitest real-browser tests).
- Adaptive loop limited to 3 iterations.
- Research extraction is regex-based (no model extraction).
- Skill execution still uses stored steps; full typed execution plans for skills are not yet exposed to the planner.
- Origin authorization is scheme-exact (an approved `http://` origin may be blocked when the site redirects to `https://`).

## Troubleshooting

- **Model not found:** Ensure Ollama is running and models are pulled. Run `npm run probe:ollama`.
- **Port conflicts:** Set `GHOST_PORT` or `DEMO_PORT`.
- **Database errors:** Run `npx prisma migrate deploy`.
- **No evidence:** Check `EVIDENCE_DIR` and permissions.
EOF
echo done