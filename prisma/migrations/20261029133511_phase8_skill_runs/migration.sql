-- CreateTable
CREATE TABLE "SkillRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "skillVersion" INTEGER NOT NULL,
    "taskId" TEXT,
    "inputsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);
