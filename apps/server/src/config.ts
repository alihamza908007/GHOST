import fs from 'fs';
import path from 'path';

/**
 * Tiny .env loader. Existing process env always wins and values are never
 * logged. This keeps Phase 1's zero-config startup working.
 */
export function loadDotEnv(cwd = process.cwd()): void {
  const candidates = [path.resolve(cwd, '.env'), path.resolve(cwd, '../../.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export interface GhostConfig {
  port: number;
  allowedOrigin: string;
  dashboardOrigins: string[];
  ollamaBaseUrl: string;
  plannerModel: string;
  visionModel: string;
  ollamaTimeoutMs: number;
  executionTimeoutMs: number;
  actionTimeoutMs: number;
  evidenceDir: string;
  modelProbeCacheMs: number;
  redactScreenshots: boolean;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GhostConfig {
  const evidenceDir = env.EVIDENCE_DIR
    ? path.resolve(env.EVIDENCE_DIR)
    : fs.existsSync(path.resolve(process.cwd(), 'evidence_store'))
      ? path.resolve(process.cwd(), 'evidence_store')
      : path.resolve(process.cwd(), '../../evidence_store');

  const dashboardOrigins = (env.GHOST_DASHBOARD_ORIGINS ??
    'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeOrigin(item, 'GHOST_DASHBOARD_ORIGINS'));

  return {
    port: positiveInt(env.GHOST_PORT, 3002),
    allowedOrigin: normalizeOrigin(
      env.GHOST_DEMO_ORIGIN ?? 'http://127.0.0.1:3001',
      'GHOST_DEMO_ORIGIN'
    ),
    dashboardOrigins,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    plannerModel: env.OLLAMA_PLANNER_MODEL ?? 'gpt-oss:20b',
    visionModel: env.OLLAMA_VISION_MODEL ?? 'lfm3-omni:2b',
    ollamaTimeoutMs: positiveInt(env.OLLAMA_TIMEOUT_MS, 45_000),
    executionTimeoutMs: positiveInt(env.GHOST_EXECUTION_TIMEOUT_MS, 120_000),
    actionTimeoutMs: positiveInt(env.GHOST_ACTION_TIMEOUT_MS, 15_000),
    evidenceDir,
    modelProbeCacheMs: positiveInt(env.GHOST_MODEL_PROBE_CACHE_MS, 60_000),
    redactScreenshots: env.GHOST_REDACT_SCREENSHOTS !== 'false',
  };
}
