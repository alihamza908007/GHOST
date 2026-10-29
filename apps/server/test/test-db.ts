import { PrismaClient } from '@prisma/client';

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
  `CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "definitionJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "SkillRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "skillVersion" INTEGER NOT NULL,
    "taskId" TEXT,
    "inputsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
  )`,
];

export async function createTestPrisma(dbPath: string): Promise<PrismaClient> {
  const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  for (const sql of schemaSql) {
    await prisma.$executeRawUnsafe(sql);
  }
  return prisma;
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000
): Promise<T> {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Timed out waiting for condition');
}
