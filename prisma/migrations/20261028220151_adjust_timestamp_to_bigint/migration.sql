/*
  Warnings:

  - You are about to alter the column `timestamp` on the `TaskEvent` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "data" TEXT NOT NULL,
    CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TaskEvent" ("data", "id", "taskId", "timestamp", "type") SELECT "data", "id", "taskId", "timestamp", "type" FROM "TaskEvent";
DROP TABLE "TaskEvent";
ALTER TABLE "new_TaskEvent" RENAME TO "TaskEvent";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
