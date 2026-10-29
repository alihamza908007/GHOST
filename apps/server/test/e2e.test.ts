import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { ActionPolicy, Plan, PlanSchema, Task } from '@ghost/core';
import { ExecutionEngine } from '@ghost/engine';
import {
  ApprovalRepository,
  EvidenceRepository,
  TaskRepository,
} from '@ghost/storage';
import { PlannerResult, PlanningContext } from '@ghost/models';
import { TaskService, PlannerLike } from '../src/task-service.js';
import { createApp } from '../src/app.js';
import { GhostConfig } from '../src/config.js';
import { createTestPrisma, waitFor } from './test-db.js';

const require = createRequire(import.meta.url);
const { createDemoServer } = require('../../../demo_target.js') as {
  createDemoServer: () => http.Server;
};

let demoServer: http.Server;
let origin: string;
let dir: string;
let dbPath: string;
let prisma: PrismaClient;

class FakePlanner implements PlannerLike {
  calls: PlanningContext[] = [];

  constructor(private readonly plannedResult: Plan) {}

  async plan(context: PlanningContext): Promise<PlannerResult> {
    this.calls.push(context);
    return { plan: this.plannedResult, attempts: 1, latencyMs: 7, model: 'fake-model' };
  }

  cancel(): void {}
}

function buildPlan(originValue: string): Plan {
  return PlanSchema.parse({
    objectiveSummary: 'Sign in to the demo and capture evidence',
    steps: [
      {
        action: { type: 'NAVIGATE', payload: { url: `${originValue}/` } },
        description: 'Open the demo application',
        expectation: { kind: 'visibleText', value: 'GHOST Demo Application' },
      },
      {
        action: {
          type: 'FILL',
          payload: {
            locator: { by: 'label', label: 'Email' },
            value: 'demo@example.com',
          },
        },
        description: 'Fill the Email field',
        expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
      },
      {
        action: {
          type: 'CLICK',
          payload: { locator: { by: 'role', role: 'button', name: 'Sign in' } },
        },
        description: 'Click the Sign in button',
        expectation: { kind: 'visibleText', value: 'Welcome back, demo user' },
      },
      {
        action: { type: 'SCREENSHOT', payload: { name: 'result' } },
        description: 'Capture the verified result',
        expectation: { kind: 'screenshot' },
      },
    ],
    rationale: 'The objective maps to the demo sign-in form.',
  });
}

function configFor(evidenceDir: string): GhostConfig {
  return {
    port: 0,
    allowedOrigin: origin,
    dashboardOrigins: ['http://localhost:3000'],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    plannerModel: 'gpt-oss:20b',
    ollamaTimeoutMs: 45_000,
    executionTimeoutMs: 60_000,
    actionTimeoutMs: 10_000,
    evidenceDir,
    modelProbeCacheMs: 1_000,
  };
}

beforeAll(async () => {
  demoServer = createDemoServer();
  await new Promise<void>((resolve) => demoServer.listen(0, '127.0.0.1', resolve));
  const address = demoServer.address();
  if (!address || typeof address === 'string') throw new Error('demo server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => demoServer.close(() => resolve()));
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-e2e-'));
  dbPath = path.join(dir, 'test.db');
  prisma = await createTestPrisma(dbPath);
});

afterEach(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function buildService(evidenceDir: string, plan: Plan) {
  const taskRepo = new TaskRepository(prisma);
  const approvalRepo = new ApprovalRepository(prisma);
  const evidenceRepo = new EvidenceRepository(evidenceDir, prisma);
  const policy = new ActionPolicy({ allowedOrigin: origin });
  const engine = new ExecutionEngine(taskRepo, evidenceRepo, origin, evidenceDir, {
    policy,
    approvalRepo,
    actionTimeoutMs: 10_000,
    taskTimeoutMs: 60_000,
  });
  const planner = new FakePlanner(plan);
  const service = new TaskService({
    taskRepo,
    approvalRepo,
    planner,
    engine,
    policy,
    plannerModel: 'gpt-oss:20b',
  });
  return { taskRepo, approvalRepo, evidenceRepo, service, planner };
}

async function taskById(service: TaskService, id: string): Promise<Task> {
  const task = await service.getTask(id);
  if (!task) throw new Error('task missing');
  return task;
}

describe('Phase 2 end-to-end (fake planner, real engine, real demo DOM)', () => {
  it(
    'plans, pauses for approval, resumes, verifies, stores evidence, and survives restart',
    async () => {
      const evidenceDir = path.join(dir, 'evidence');
      const { service, taskRepo } = await buildService(evidenceDir, buildPlan(origin));
      const created = await service.startTask(
        'Open the demo, fill Email, click Sign in, and capture evidence.'
      );

      const paused = await waitFor(
        () => taskById(service, created.id),
        (task) => ['AWAITING_APPROVAL', 'FAILED', 'COMPLETED'].includes(task.status)
      );
      expect(paused.status).toBe('AWAITING_APPROVAL');
      expect(paused.plan?.steps).toHaveLength(4);
      expect(paused.currentStepIndex).toBe(1);

      const pending = await service.getPendingApproval(created.id);
      expect(pending?.status).toBe('PENDING');
      expect(pending?.reason).toContain('sensitive');

      const app = await createApp(
        {
          config: configFor(evidenceDir),
          taskService: service,
          getModelHealth: async () => ({ capabilities: null, error: null }),
        },
        { logger: false }
      );

      // Dashboard history includes the task and redacts the fill value.
      const history = await app.inject({ method: 'GET', url: '/tasks' });
      expect(history.statusCode).toBe(200);
      const historyBody = JSON.parse(history.body);
      expect(historyBody.tasks[0].id).toBe(created.id);

      const detail = await app.inject({ method: 'GET', url: `/tasks/${created.id}` });
      expect(detail.statusCode).toBe(200);
      const detailBody = JSON.parse(detail.body);
      expect(detailBody.pendingApproval.id).toBe(pending?.id);
      expect(detailBody.plan.steps[1].action.payload.value).toBe('[redacted]');

      const approval = await app.inject({
        method: 'POST',
        url: `/tasks/${created.id}/approval`,
        payload: { decision: 'approve', approvalId: pending?.id },
      });
      expect(approval.statusCode).toBe(200);

      const completed = await waitFor(
        () => taskById(service, created.id),
        (task) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.currentStepIndex).toBe(4);

      const events = await taskRepo.getEvents(created.id);
      const types = events.map((event) => event.type);
      expect(types).toContain('PLANNING_STARTED');
      expect(types).toContain('PLANNING_COMPLETED');
      expect(types).toContain('PLAN_READY');
      expect(types).toContain('APPROVAL_REQUIRED');
      expect(types).toContain('APPROVAL_GRANTED');
      expect(types).toContain('TASK_COMPLETED');
      expect(types.filter((type) => type === 'VERIFICATION_RESULT')).toHaveLength(4);
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: events.length }, (_, index) => index + 1)
      );

      const planReadyIndex = types.indexOf('PLAN_READY');
      const approvalIndex = types.indexOf('APPROVAL_REQUIRED');
      const grantedIndex = types.indexOf('APPROVAL_GRANTED');
      expect(planReadyIndex).toBeLessThan(approvalIndex);
      expect(grantedIndex).toBeLessThan(types.lastIndexOf('TASK_COMPLETED'));

      const verifications = events.filter((event) => event.type === 'VERIFICATION_RESULT');
      expect(verifications.every((event) => event.data.outcome === 'passed')).toBe(true);
      const screenshotEvent = verifications.find((event) => event.data.evidenceRef);
      expect(screenshotEvent).toBeTruthy();
      const screenshotFilename = screenshotEvent?.data.evidenceRef as string;
      const screenshotPath = path.join(evidenceDir, screenshotFilename);
      expect(fs.existsSync(screenshotPath)).toBe(true);
      expect(fs.statSync(screenshotPath).size).toBeGreaterThan(0);
      expect(screenshotFilename).toContain(created.id);

      const evidenceRecords = await prisma.evidence.findMany({
        where: { taskId: created.id },
      });
      expect(evidenceRecords).toHaveLength(1);
      expect(evidenceRecords[0].size).toBeGreaterThan(0);

      const shotUrl = await app.inject({
        method: 'GET',
        url: `/tasks/${created.id}/screenshot-url`,
      });
      expect(shotUrl.statusCode).toBe(200);
      expect(JSON.parse(shotUrl.body).url).toContain(screenshotFilename);

      const eventApi = await app.inject({
        method: 'GET',
        url: `/tasks/${created.id}/events`,
      });
      const eventBody = JSON.parse(eventApi.body);
      expect(eventBody.events[0].type).toBe('TASK_CREATED');
      expect(eventBody.events.at(-1).type).toBe('TASK_COMPLETED');

      await app.close();

      // Simulated restart: a new client sees the same persisted history.
      await prisma.$disconnect();
      prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
      const restartedRepo = new TaskRepository(prisma);
      const restartedTask = await restartedRepo.getById(created.id);
      const restartedEvents = await restartedRepo.getEvents(created.id);
      expect(restartedTask?.status).toBe('COMPLETED');
      expect(restartedTask?.plan?.steps).toHaveLength(4);
      expect(restartedEvents.at(-1)?.type).toBe('TASK_COMPLETED');
    },
    90_000
  );

  it(
    'rejection cancels the plan without executing the pending action',
    async () => {
      const evidenceDir = path.join(dir, 'evidence-reject');
      const { service, taskRepo } = await buildService(evidenceDir, buildPlan(origin));
      const created = await service.startTask('Sign in and screenshot.');

      const paused = await waitFor(
        () => taskById(service, created.id),
        (task) => ['AWAITING_APPROVAL', 'FAILED'].includes(task.status)
      );
      expect(paused.status).toBe('AWAITING_APPROVAL');
      const pending = await service.getPendingApproval(created.id);
      expect(pending).toBeTruthy();

      const app = await createApp(
        {
          config: configFor(evidenceDir),
          taskService: service,
          getModelHealth: async () => ({ capabilities: null, error: null }),
        },
        { logger: false }
      );

      const rejection = await app.inject({
        method: 'POST',
        url: `/tasks/${created.id}/approval`,
        payload: { decision: 'reject', approvalId: pending?.id },
      });
      expect(rejection.statusCode).toBe(200);
      await app.close();

      const cancelled = await taskById(service, created.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.error).toContain('rejected');

      const events = await taskRepo.getEvents(created.id);
      const types = events.map((event) => event.type);
      expect(types).toContain('APPROVAL_REJECTED');
      expect(types).toContain('TASK_CANCELLED');
      expect(types).not.toContain('TASK_COMPLETED');
      const startedActions = events.filter((event) => event.type === 'ACTION_STARTED');
      expect(startedActions).toHaveLength(1);
      expect(startedActions[0].data.actionType).toBe('NAVIGATE');

      const approvals = await prisma.approvalRequest.findMany({
        where: { taskId: created.id },
      });
      expect(approvals[0].status).toBe('REJECTED');
    },
    60_000
  );
});
