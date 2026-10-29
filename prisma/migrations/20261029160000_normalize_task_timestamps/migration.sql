-- Phase 1 rows created before the Phase 2 schema used SQLite's TEXT datetime
-- default, while Prisma writes INTEGER epoch milliseconds. Mixed storage types
-- make ORDER BY createdAt unreliable (SQLite sorts INTEGER before TEXT), so
-- normalize legacy values once.
UPDATE "Task"
SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000
WHERE typeof("createdAt") = 'text';

UPDATE "Task"
SET "updatedAt" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000
WHERE typeof("updatedAt") = 'text';
