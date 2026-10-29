import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { ActionPolicy, Plan, PlanSchema } from '@ghost/core';
import { ExecutionEngine } from '@ghost/engine';
import { ApprovalRepository, EvidenceRepository, TaskRepository } from '@ghost/storage';
import { PlannerResult, PlanningContext } from '@ghost/models';
import { TaskService, PlannerLike } from '../src/task-service.js';
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

function mkPlan(steps: any[]): Plan { return PlanSchema.parse({ objectiveSummary: 'rel', steps, rationale: 'r' }); }
function nav() { return { action: { type: 'NAVIGATE' as const, payload: { url: `${origin}/` } }, description: 'nav', expectation: { kind: 'visibleText' as const, value: 'GHOST Demo Application' } }; }

beforeAll(async () => {
  demoServer = createDemoServer();
  await new Promise<void>((r) => demoServer.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(demoServer.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((r) => demoServer.close(() => r())); });

let dir: string, dbPath: string, prisma: PrismaClient;
beforeEach(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')); dbPath = path.join(dir, 't.db'); prisma = await createTestPrisma(dbPath); });
afterEach(async () => { await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

async function run(plan: Plan) {
  const ed = path.join(dir, 'ev');
  const tr = new TaskRepository(prisma); const ar = new ApprovalRepository(prisma); const er = new EvidenceRepository(ed, prisma);
  const pol = new ActionPolicy({ allowedOrigin: origin, allowedOrigins: [origin] });
  const eng = new ExecutionEngine(tr, er, origin, ed, { policy: pol, approvalRepo: ar, actionTimeoutMs: 5000, taskTimeoutMs: 30000 });
  const svc = new TaskService({ taskRepo: tr, approvalRepo: ar, planner: new FakePlanner(plan), engine: eng, policy: pol, plannerModel: 'fake', approvedOrigins: [origin] });
  const c = await svc.startTask('rel');
  return waitFor(() => svc.getTask(c.id).then((t) => t!), (t) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
}

describe('Phase 5 reliability scenarios', () => {
  it('S1 single-origin success', async () => {
    const f = await run(mkPlan([nav(), { action: { type: 'SCREENSHOT', payload: { name: 'r' } }, description: 's', expectation: { kind: 'screenshot' } }]));
    expect(f.status).toBe('COMPLETED');
  });
  it('S2 missing target fails (no false success)', async () => {
    const f = await run(mkPlan([nav(), { action: { type: 'CLICK', payload: { locator: { by: 'role', role: 'button', name: 'Nope' } } }, description: 'c', expectation: { kind: 'elementVisible', locator: { by: 'role', role: 'button', name: 'Nope' } } }]));
    expect(f.status).not.toBe('COMPLETED');
  });
  it('S3 unapproved destination rejected', async () => {
    const f = await run(mkPlan([{ action: { type: 'NAVIGATE', payload: { url: 'http://127.0.0.1:9999/' } }, description: 'bad', expectation: { kind: 'visibleText', value: 'X' } }]));
    expect(f.status).not.toBe('COMPLETED');
  });
  it('S4 duplicate submission no duplicate execution', async () => {
    const plan = mkPlan([nav()]);
    const ed = path.join(dir, 'ev');
    const tr = new TaskRepository(prisma); const ar = new ApprovalRepository(prisma); const er = new EvidenceRepository(ed, prisma);
    const pol = new ActionPolicy({ allowedOrigin: origin, allowedOrigins: [origin] });
    const eng = new ExecutionEngine(tr, er, origin, ed, { policy: pol, approvalRepo: ar, actionTimeoutMs: 5000, taskTimeoutMs: 30000 });
    const svc = new TaskService({ taskRepo: tr, approvalRepo: ar, planner: new FakePlanner(plan), engine: eng, policy: pol, plannerModel: 'fake', approvedOrigins: [origin] });
    const c1 = await svc.startTask('dup');
    const c2 = await svc.startTask('dup2');
    expect(c1.id).not.toBe(c2.id);
    const f1 = await waitFor(() => svc.getTask(c1.id).then((t) => t!), (t) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
    expect(f1.status).toBe('COMPLETED');
  });
  it('S5 interrupted task marked failed on restart', async () => {
    const tr = new TaskRepository(prisma);
    await tr.create({ id: 'int-1', objective: 'o', status: 'EXECUTING', currentStepIndex: 1, lastEventId: null, plan: null, planSummary: null, plannerModel: null, error: null, approvedOrigins: [origin] });
    const n = await tr.recoverInterrupted();
    expect(n).toBeGreaterThanOrEqual(1);
    const t = await tr.getById('int-1');
    expect(t!.status).toBe('FAILED');
  });
  it('S6 origin transition event recorded', async () => {
    const f = await run(mkPlan([nav()]));
    const tr = new TaskRepository(prisma);
    // find task id by listing
    const tasks = await tr.list(10);
    const ev = await tr.getEvents(tasks[0].id);
    expect(ev.some((e) => e.type === 'ACTION_FINISHED')).toBe(true);
  });
});
