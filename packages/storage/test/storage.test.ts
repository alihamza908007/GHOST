import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  ApprovalRepository,
  EvidenceRepository,
  TaskRepository,
} from '../src/index.js';
import { Plan, Task } from '@ghost/core';

const schemaSql = [
  `CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentStepIndex" INTEGER NOT NULL,
    "lastEventId" TEXT,
    "planJson" TEXT,
    "planSummary" TEXT,
    "plannerModel" TEXT,
    "approvedOriginsJson" TEXT,
    "researchFieldsJson" TEXT,
    "researchBudget" INTEGER,
    "researchResultJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL,
    CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "actionJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" BIGINT NOT NULL,
    "decidedAt" BIGINT,
    CONSTRAINT "ApprovalRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    CONSTRAINT "Evidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
];

let dir: string;
let dbPath: string;
let prisma: PrismaClient;

async function createPrisma(): Promise<PrismaClient> {
  const client = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  for (const sql of schemaSql) {
    await client.$executeRawUnsafe(sql);
  }
  return client;
}

const task = (id: string): Task => ({
  id,
  objective: 'Persist this task',
  status: 'PLANNING',
  currentStepIndex: 0,
  lastEventId: null,
  plan: null,
  planSummary: null,
  plannerModel: 'gpt-oss:20b',
  error: null,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-storage-'));
  dbPath = path.join(dir, 'test.db');
  prisma = await createPrisma();
});

afterEach(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('@ghost/storage TaskRepository persistence', () => {
  it('creates, updates, lists, and persists a validated plan', async () => {
    const repo = new TaskRepository(prisma);
    const record = task('task-1');
    await repo.create(record);

    const plan: Plan = {
      objectiveSummary: 'Open demo and screenshot',
      steps: [
        {
          action: { type: 'NAVIGATE', payload: { url: 'http://127.0.0.1:3001/' } },
          description: 'Open demo',
          expectation: { kind: 'visibleText', value: 'GHOST Demo Application' },
        },
        {
          action: { type: 'SCREENSHOT', payload: { name: 'result' } },
          description: 'Capture result',
          expectation: { kind: 'screenshot' },
        },
      ],
    };

    await repo.update('task-1', {
      status: 'PLAN_READY',
      plan,
      planSummary: plan.objectiveSummary,
      currentStepIndex: 0,
    });

    const loaded = await repo.getById('task-1');
    expect(loaded?.status).toBe('PLAN_READY');
    expect(loaded?.plan?.steps).toHaveLength(2);
    expect(loaded?.planSummary).toBe(plan.objectiveSummary);

    const listed = await repo.list();
    expect(listed.map((item) => item.id)).toContain('task-1');
  });

  it('assigns monotonic per-task sequence numbers regardless of timestamp', async () => {
    const repo = new TaskRepository(prisma);
    await repo.create(task('task-seq'));

    for (const [index, type] of ['TASK_CREATED', 'PLANNING_STARTED', 'PLAN_READY'].entries()) {
      await repo.addEvent({
        id: `event-${index}`,
        taskId: 'task-seq',
        type: type as never,
        timestamp: Date.now() - (10 - index) * 1_000,
        data: { index },
      });
    }

    const events = await repo.getEvents('task-seq');
    expect(events.map((event) => event.id)).toEqual(['event-0', 'event-1', 'event-2']);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('reads legacy TEXT datetimes as epoch milliseconds', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id", "objective", "status", "currentStepIndex", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
      'task-legacy-text',
      'Legacy Phase 1 row',
      'FAILED',
      0,
      '2026-10-29 10:37:45',
      '2026-10-29 10:38:00'
    );

    const loaded = await new TaskRepository(prisma).getById('task-legacy-text');
    expect(loaded?.createdAt).toBe(Date.parse('2026-10-29T10:37:45Z'));
    expect(loaded?.updatedAt).toBe(Date.parse('2026-10-29T10:38:00Z'));
  });

  it('orders normalized history by creation time', async () => {
    const repo = new TaskRepository(prisma);
    await repo.create({ ...task('task-old'), status: 'COMPLETED' });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await repo.create(task('task-new'));

    await prisma.$executeRawUnsafe(
      `UPDATE "Task"
       SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000
       WHERE typeof("createdAt") = 'text'`
    );

    const listed = await repo.list();
    expect(listed[0].id).toBe('task-new');
    expect(listed[1].id).toBe('task-old');
  });

  it('preserves task history across a simulated server restart', async () => {
    const first = new TaskRepository(prisma);
    await first.create(task('task-restart'));
    await first.addEvent({
      id: 'evt-restart',
      taskId: 'task-restart',
      type: 'PLANNING_STARTED',
      timestamp: Date.now(),
      data: { model: 'gpt-oss:20b' },
    });
    await prisma.$disconnect();

    prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
    const second = new TaskRepository(prisma);
    const loaded = await second.getById('task-restart');
    const events = await second.getEvents('task-restart');
    expect(loaded?.objective).toBe('Persist this task');
    expect(events[0].type).toBe('PLANNING_STARTED');
  });

  it('marks interrupted tasks failed while preserving history', async () => {
    const repo = new TaskRepository(prisma);
    await repo.create({ ...task('task-interrupted'), status: 'EXECUTING' });
    const count = await repo.recoverInterrupted();
    expect(count).toBe(1);
    const loaded = await repo.getById('task-interrupted');
    expect(loaded?.status).toBe('FAILED');
    expect(loaded?.error).toContain('server restart');
    const events = await repo.getEvents('task-interrupted');
    expect(events.some((event) => event.type === 'TASK_INTERRUPTED')).toBe(true);
  });
});

describe('@ghost/storage ApprovalRepository', () => {
  it('persists a pending decision and prevents double decisions', async () => {
    const repo = new TaskRepository(prisma);
    await repo.create(task('task-approval'));
    const approvals = new ApprovalRepository(prisma);

    const pending = await approvals.createPending({
      taskId: 'task-approval',
      stepIndex: 1,
      action: {
        type: 'FILL',
        payload: { locator: { by: 'label', label: 'Email' }, value: 'demo@example.com' },
      },
      reason: 'sensitive field',
    });

    expect((await approvals.getPending('task-approval'))?.id).toBe(pending.id);
    const first = await approvals.decide(pending.id, 'APPROVED');
    expect(first?.status).toBe('APPROVED');
    const second = await approvals.decide(pending.id, 'REJECTED');
    expect(second).toBeNull();
  });
});

describe('@ghost/storage EvidenceRepository with Prisma', () => {
  it('records screenshot evidence in addition to the file store', async () => {
    const repo = new TaskRepository(prisma);
    await repo.create(task('task-evidence'));
    const evidence = new EvidenceRepository(dir, prisma);
    fs.writeFileSync(evidence.getFilePath('shot.png'), Buffer.from('image'));
    await evidence.save({
      id: 'evidence-1',
      taskId: 'task-evidence',
      filename: 'shot.png',
      type: 'screenshot',
      timestamp: Date.now(),
    });

    const records = await prisma.evidence.findMany({ where: { taskId: 'task-evidence' } });
    expect(records).toHaveLength(1);
    expect(records[0].size).toBe(5);
  });
});

describe('@ghost/storage EvidenceRepository filesystem', () => {
  it('creates a directory and resolves safe evidence paths', () => {
    const base = path.join(dir, 'files-only');
    const repo = new EvidenceRepository(base);
    expect(fs.existsSync(base)).toBe(true);

    const filename = 'test-file.png';
    expect(repo.getFilePath(filename)).toBe(path.resolve(base, filename));
    expect(repo.exists(filename)).toBe(false);
    expect(repo.size(filename)).toBe(0);

    fs.writeFileSync(repo.getFilePath(filename), 'dummy-content');
    expect(repo.exists(filename)).toBe(true);
    expect(repo.size(filename)).toBeGreaterThan(0);
  });
});
