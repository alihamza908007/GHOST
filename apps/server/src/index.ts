import { PrismaClient } from '@prisma/client';
import { ActionPolicy, CapabilitySnapshot } from '@ghost/core';
import {
  ApprovalRepository,
  EvidenceRepository,
  TaskRepository,
} from '@ghost/storage';
import { ExecutionEngine } from '@ghost/engine';
import {
  isModelError,
  ModelProviderCapabilities,
  OllamaProvider,
  OllamaVisionObserver,
  StructuredPlanner,
} from '@ghost/models';
import { createApp, ModelHealth } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { TaskService } from './task-service.js';

async function collectPageObservation(origin: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 2_500);
  try {
    const response = await fetch(origin, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    if (!response.ok) return [];
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return [];
    const html = (await response.text()).slice(0, 50_000);
    const text = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? [text.slice(0, 1_500)] : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const prisma = new PrismaClient();
  const taskRepo = new TaskRepository(prisma);
  const approvalRepo = new ApprovalRepository(prisma);
  const evidenceRepo = new EvidenceRepository(config.evidenceDir, prisma);

  const policy = new ActionPolicy({ allowedOrigin: config.allowedOrigin });
  const provider = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.plannerModel,
    timeoutMs: config.ollamaTimeoutMs,
  });
  const visionProvider = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.visionModel,
    timeoutMs: config.ollamaTimeoutMs,
  });
  const visionObserver = new OllamaVisionObserver(visionProvider, config.ollamaTimeoutMs, 256);
  const planner = new StructuredPlanner(provider, { policy });
  const engine = new ExecutionEngine(
    taskRepo,
    evidenceRepo,
    config.allowedOrigin,
    config.evidenceDir,
    {
      policy,
      approvalRepo,
      taskTimeoutMs: config.executionTimeoutMs,
      actionTimeoutMs: config.actionTimeoutMs,
      visual: visionObserver,
      visionTimeoutMs: config.ollamaTimeoutMs,
      redactScreenshots: config.redactScreenshots,
      recoveryLimit: 2,
      maxRetriesPerAction: 1,
      recoveryCloseAllowlist: ['Close', 'testid:overlay-close'],
    }
  );

  const taskService = new TaskService({
    taskRepo,
    approvalRepo,
    planner,
    engine,
    policy,
    plannerModel: config.plannerModel,
    observationProvider: () => collectPageObservation(config.allowedOrigin),
  });

  const recovered = await taskRepo.recoverInterrupted();
  if (recovered > 0) {
    console.log(`Recovered ${recovered} interrupted task(s); history was preserved.`);
  }

  let cachedHealth: { at: number; value: ModelHealth } | null = null;
  const getModelHealth = async (): Promise<ModelHealth> => {
    const now = Date.now();
    if (cachedHealth && now - cachedHealth.at < config.modelProbeCacheMs) {
      return cachedHealth.value;
    }

    let capabilities: ModelProviderCapabilities | null = null;
    let error: ModelHealth['error'] = null;
    try {
      capabilities = await provider.probe({ testGeneration: false });
    } catch (probeError) {
      const code = isModelError(probeError) ? probeError.code : 'CONNECTION_FAILED';
      const message = isModelError(probeError)
        ? probeError.message
        : 'Unable to probe the local planner model';
      error = { code, message };
    }

    let visionCapabilities: ModelProviderCapabilities | null = null;
    let visionError: ModelHealth['error'] = null;
    try {
      visionCapabilities = await visionObserver.probe();
    } catch (probeError) {
      const code = isModelError(probeError) ? probeError.code : 'CONNECTION_FAILED';
      const message = isModelError(probeError)
        ? probeError.message
        : 'Unable to probe the local vision model';
      visionError = { code, message };
    }

    const snapshot: CapabilitySnapshot = {
      plannerModel: config.plannerModel,
      connected: capabilities?.connected ?? error?.code !== 'CONNECTION_FAILED',
      modelAvailable: capabilities?.modelAvailable ?? false,
      textGeneration: capabilities?.textGeneration ?? false,
      structuredOutput: capabilities?.structuredOutput ?? false,
      vision: capabilities?.vision ?? visionCapabilities?.vision ?? false,
      degradedFeatures: capabilities?.degradedFeatures ?? ['planner_unavailable'],
      lastErrorCode: error?.code,
      checkedAt: now,
      visionModel: config.visionModel,
      visionConnected: visionCapabilities?.connected ?? false,
      visionLastErrorCode: visionError?.code,
    };

    const value: ModelHealth = { capabilities: snapshot, error };
    cachedHealth = { at: now, value };
    return value;
  };

  const app = await createApp({ config, taskService, getModelHealth });

  const shutdown = async () => {
    provider.cancelAll();
    visionProvider.cancelAll();
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`GHOST Phase 2 server running at http://localhost:${config.port}`);
  console.log(`Allowed demo origin: ${config.allowedOrigin}`);
  console.log(`Planner model: ${config.plannerModel} (local Ollama only)`);
  console.log(`Vision model: ${config.visionModel} (local Ollama only, optional)`);
}

main().catch((error) => {
  // Deliberately avoid dumping prompts or model output.
  console.error(
    'GHOST server failed to start:',
    error instanceof Error ? error.message : 'unknown error'
  );
  process.exit(1);
});
