import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { ActionPolicy, Plan, PlanSchema } from '@ghost/core';
import { ExecutionEngine } from '@ghost/engine';
import { ApprovalRepository, EvidenceRepository, TaskRepository, SkillRepository, SkillRunRepository } from '@ghost/storage';
import { PlannerResult, PlanningContext } from '@ghost/models';
import { TaskService, PlannerLike } from '../src/task-service.js';
import { createApp } from '../src/app.js';
import { GhostConfig } from '../src/config.js';
import { createTestPrisma, waitFor } from './test-db.js';

const require = createRequire(import.meta.url);
const { createDemoServer } = require('../../../demo_target.js') as { createDemoServer: () => http.Server };

let demoServer: http.Server;
let origin: string;

class FakePlanner implements PlannerLike {
  constructor(private plannedResult: Plan) {}
  async plan(): Promise<PlannerResult> { return { plan: this.plannedResult, attempts: 1, latencyMs: 5, model: 'fake' }; }
  cancel(): void {}
}

function mkPlan(steps: any[]): Plan { return PlanSchema.parse({ objectiveSummary: 'skill', steps, rationale: 'r' }); }

beforeAll(async () => {
  demoServer = createDemoServer();
  await new Promise<void>((r) => demoServer.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(demoServer.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((r) => demoServer.close(() => r())); });

let dir: string, dbPath: string, prisma: PrismaClient;
beforeEach(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-')); dbPath = path.join(dir, 't.db'); prisma = await createTestPrisma(dbPath); });
afterEach(async () => { await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('Skill execution E2E', () => {
  it('saves and runs a skill', async () => {
    const evidenceDir = path.join(dir, 'ev');
    const taskRepo = new TaskRepository(prisma);
    const approvalRepo = new ApprovalRepository(prisma);
    const evidenceRepo = new EvidenceRepository(evidenceDir, prisma);
    const skillRepo = new SkillRepository(prisma);
    const policy = new ActionPolicy({ allowedOrigin: origin, allowedOrigins: [origin] });
    const engine = new ExecutionEngine(taskRepo, evidenceRepo, origin, evidenceDir, { policy, approvalRepo, actionTimeoutMs: 10000, taskTimeoutMs: 60000 });
    const plan = mkPlan([{ action: { type: 'NAVIGATE', payload: { url: `${origin}/` } }, description: 'nav', expectation: { kind: 'visibleText', value: 'GHOST Demo Application' } }]);
    const service = new TaskService({ taskRepo, approvalRepo, planner: new FakePlanner(plan), engine, policy, plannerModel: 'fake', approvedOrigins: [origin] });
    // Save skill
    await skillRepo.save({ id: 'sk1', name: 'NavSkill', version: 1, definition: { name: 'NavSkill', inputs: [], steps: plan.steps } });
    const skill = await skillRepo.get('sk1');
    expect(skill).not.toBeNull();
    // Run skill
    const task = await service.runSkill(skill!, {}, [origin]);
    const final = await waitFor(() => service.getTask(task.id).then((t) => t!), (t) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
    expect(final.status).toBe('COMPLETED');
  });

  it('rejects invalid skill id lookup', async () => {
    const skillRepo = new SkillRepository(prisma);
    const skill = await skillRepo.get('nonexistent');
    expect(skill).toBeNull();
  });

  it('runs skill with parameter substitution', async () => {
    const skillRepo = new SkillRepository(prisma);
    const skill = { id: 'sk2', name: 'ParamSkill', version: 1, definition: { name: 'ParamSkill', inputs: [{ name: 'target', type: 'string', required: true }], steps: [{ action: { type: 'NAVIGATE', payload: { url: '{{target}}' } }, description: 'go to {{target}}', expectation: { kind: 'visibleText', value: 'GHOST Demo Application' } }] } };
    await skillRepo.save(skill);
    const saved = await skillRepo.get('sk2');
    const taskRepo = new TaskRepository(prisma);
    const approvalRepo = new ApprovalRepository(prisma);
    const evidenceDir = path.join(dir, 'evp');
    const evidenceRepo = new EvidenceRepository(evidenceDir, prisma);
    const policy = new ActionPolicy({ allowedOrigin: origin, allowedOrigins: [origin] });
    const engine = new ExecutionEngine(taskRepo, evidenceRepo, origin, evidenceDir, { policy, approvalRepo, actionTimeoutMs: 10000, taskTimeoutMs: 60000 });
    const service = new TaskService({ taskRepo, approvalRepo, planner: new FakePlanner(mkPlan([])), engine, policy, plannerModel: 'fake', approvedOrigins: [origin], skillRunRepo: new SkillRunRepository(prisma) });
    const task = await service.runSkill(saved!, { target: origin }, [origin]);
    const final = await waitFor(() => service.getTask(task.id).then((t) => t!), (t) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
    expect(final.status).toBe('COMPLETED');
  });

  it('rejects missing skill input', async () => {
    const skillRepo = new SkillRepository(prisma);
    const skill = { id: 'sk3', name: 'ParamSkill2', version: 1, definition: { name: 'ParamSkill2', inputs: [{ name: 'target', type: 'string', required: true }], steps: [] } };
    await skillRepo.save(skill);
    const saved = await skillRepo.get('sk3');
    const taskRepo = new TaskRepository(prisma);
    const approvalRepo = new ApprovalRepository(prisma);
    const evidenceDir = path.join(dir, 'evp2');
    const evidenceRepo = new EvidenceRepository(evidenceDir, prisma);
    const policy = new ActionPolicy({ allowedOrigin: origin, allowedOrigins: [origin] });
    const engine = new ExecutionEngine(taskRepo, evidenceRepo, origin, evidenceDir, { policy, approvalRepo, actionTimeoutMs: 10000, taskTimeoutMs: 60000 });
    const service = new TaskService({ taskRepo, approvalRepo, planner: new FakePlanner(mkPlan([])), engine, policy, plannerModel: 'fake', approvedOrigins: [origin] });
    await expect(service.runSkill(saved!, {}, [origin])).rejects.toThrow();
  });
});

describe('Research workflow E2E', () => {
  it('runs research and stores result', async () => {
    const demoServer = createDemoServer();
    await new Promise<void>((r) => demoServer.listen(0, '127.0.0.1', r));
    const researchOrigin = `http://127.0.0.1:${(demoServer.address() as any).port}`;
    // Use research scenario
    const res = await fetch(`${researchOrigin}/?scenario=research`);
    expect(res.ok).toBe(true);

    const evidenceDir = path.join(dir, 'evr');
    const taskRepo = new TaskRepository(prisma);
    const approvalRepo = new ApprovalRepository(prisma);
    const evidenceRepo = new EvidenceRepository(evidenceDir, prisma);
    const policy = new ActionPolicy({ allowedOrigin: researchOrigin, allowedOrigins: [researchOrigin] });
    const engine = new ExecutionEngine(taskRepo, evidenceRepo, researchOrigin, evidenceDir, { policy, approvalRepo, actionTimeoutMs: 10000, taskTimeoutMs: 60000 });
    const service = new TaskService({ taskRepo, approvalRepo, planner: new FakePlanner(mkPlan([])), engine, policy, plannerModel: 'fake', approvedOrigins: [researchOrigin] });

    const task = await service.startResearch('Find version', [researchOrigin], [{ name: 'Version', type: 'string' }], 2);
    // Wait for completion
    const final = await waitFor(() => service.getTask(task.id).then((t) => t!), (t) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
    await new Promise<void>((r) => demoServer.close(() => r()));
    expect(final.status).toBe('COMPLETED');
    expect(final.researchResultJson).toBeTruthy();
    const result = JSON.parse(final.researchResultJson!);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
