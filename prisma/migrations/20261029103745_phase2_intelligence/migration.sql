-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "actionJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" BIGINT NOT NULL,
    "decidedAt" BIGINT,
    CONSTRAINT "ApprovalRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    CONSTRAINT "Evidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentStepIndex" INTEGER NOT NULL,
    "lastEventId" TEXT,
    "planJson" TEXT,
    "planSummary" TEXT,
    "plannerModel" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Task" ("currentStepIndex", "id", "lastEventId", "objective", "status") SELECT "currentStepIndex", "id", "lastEventId", "objective", "status" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE TABLE "new_TaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL,
    CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TaskEvent" ("data", "id", "taskId", "timestamp", "type") SELECT "data", "id", "taskId", "timestamp", "type" FROM "TaskEvent";
DROP TABLE "TaskEvent";
ALTER TABLE "new_TaskEvent" RENAME TO "TaskEvent";
CREATE INDEX "TaskEvent_taskId_seq_idx" ON "TaskEvent"("taskId", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ApprovalRequest_taskId_status_idx" ON "ApprovalRequest"("taskId", "status");

-- CreateIndex
CREATE INDEX "Evidence_taskId_idx" ON "Evidence"("taskId");
