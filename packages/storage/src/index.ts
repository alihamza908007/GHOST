import {
  Action,
  ApprovalRequestRecord,
  ApprovalStatus,
  Plan,
  Task,
  TaskEvent,
  TaskEventType,
  TaskStatus,
} from '@ghost/core';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export interface ITaskRepository {
  create(task: Task): Promise<void>;
  update(id: string, updates: Partial<Task>): Promise<void>;
  getById(id: string): Promise<Task | null>;
  list(limit?: number): Promise<Task[]>;
  addEvent(event: TaskEvent): Promise<void>;
  getEvents(taskId: string): Promise<TaskEvent[]>;
  recoverInterrupted(): Promise<number>;
}

export interface IEvidenceRepository {
  save(evidence: {
    id?: string;
    taskId: string;
    filename: string;
    type: string;
    timestamp: number;
    size?: number;
  }): Promise<void>;
  getFilePath(filename: string): string;
  exists(filename: string): boolean;
  size(filename: string): number;
}

export interface CreateApprovalInput {
  taskId: string;
  stepIndex: number;
  action: Action;
  reason: string;
}

export interface IApprovalRepository {
  createPending(input: CreateApprovalInput): Promise<ApprovalRequestRecord>;
  getPending(taskId: string): Promise<ApprovalRequestRecord | null>;
  getById(id: string): Promise<ApprovalRequestRecord | null>;
  decide(id: string, decision: Exclude<ApprovalStatus, 'PENDING'>): Promise<ApprovalRequestRecord | null>;
  listByTask(taskId: string): Promise<ApprovalRequestRecord[]>;
}

function parsePlan(planJson: string | null): Plan | null {
  if (!planJson) return null;
  try {
    return JSON.parse(planJson) as Plan;
  } catch {
    return null;
  }
}

function toEpoch(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function mapTask(task: any): Task {
  return {
    id: task.id,
    objective: task.objective,
    status: task.status as TaskStatus,
    currentStepIndex: task.currentStepIndex,
    lastEventId: task.lastEventId,
    plan: parsePlan(task.planJson),
    planSummary: task.planSummary,
    plannerModel: task.plannerModel,
    error: task.error,
    // Tolerate legacy TEXT datetimes as well as Prisma's INTEGER epoch ms.
    createdAt: toEpoch(task.createdAt),
    updatedAt: toEpoch(task.updatedAt),
  };
}

export class TaskRepository implements ITaskRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(task: Task): Promise<void> {
    await this.prisma.task.create({
      data: {
        id: task.id,
        objective: task.objective,
        status: task.status,
        currentStepIndex: task.currentStepIndex,
        lastEventId: task.lastEventId,
        planJson: task.plan ? JSON.stringify(task.plan) : null,
        planSummary: task.planSummary ?? null,
        plannerModel: task.plannerModel ?? null,
        error: task.error ?? null,
      },
    });
  }

  async update(id: string, updates: Partial<Task>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (updates.status !== undefined) data.status = updates.status;
    if (updates.currentStepIndex !== undefined) data.currentStepIndex = updates.currentStepIndex;
    if (updates.lastEventId !== undefined) data.lastEventId = updates.lastEventId;
    if (updates.plan !== undefined) data.planJson = updates.plan ? JSON.stringify(updates.plan) : null;
    if (updates.planSummary !== undefined) data.planSummary = updates.planSummary;
    if (updates.plannerModel !== undefined) data.plannerModel = updates.plannerModel;
    if (updates.error !== undefined) data.error = updates.error;

    if (Object.keys(data).length === 0) return;
    await this.prisma.task.update({ where: { id }, data });
  }

  async getById(id: string): Promise<Task | null> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    return task ? mapTask(task) : null;
  }

  async list(limit = 50): Promise<Task[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    return tasks.map(mapTask);
  }

  async addEvent(event: TaskEvent): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      const aggregate = await tx.taskEvent.aggregate({
        where: { taskId: event.taskId },
        _max: { seq: true },
      });
      const seq = (aggregate._max.seq ?? 0) + 1;
      await tx.taskEvent.create({
        data: {
          id: event.id,
          taskId: event.taskId,
          type: event.type,
          timestamp: BigInt(event.timestamp),
          seq,
          data: JSON.stringify(event.data ?? {}),
        },
      });
      await tx.task.update({
        where: { id: event.taskId },
        data: { lastEventId: event.id },
      });
    });
  }

  async getEvents(taskId: string): Promise<TaskEvent[]> {
    const events = await this.prisma.taskEvent.findMany({
      where: { taskId },
      orderBy: [{ seq: 'asc' }, { timestamp: 'asc' }],
    });
    return events.map((event: any) => ({
      id: event.id,
      taskId: event.taskId,
      type: event.type as TaskEventType,
      timestamp: Number(event.timestamp),
      seq: event.seq,
      data: JSON.parse(event.data),
    }));
  }

  /**
   * A restart cannot resume an in-flight browser process. Mark interrupted
   * tasks failed, keep their full history, and record why.
   */
  async recoverInterrupted(): Promise<number> {
    const interrupted = await this.prisma.task.findMany({
      where: {
        status: {
          in: ['PLANNING', 'PLAN_READY', 'EXECUTING', 'VERIFYING', 'AWAITING_APPROVAL'],
        },
      },
    });

    for (const task of interrupted) {
      await this.update(task.id, {
        status: 'FAILED',
        error: 'Task was interrupted by a server restart. Retry to run it again.',
      });
      await this.addEvent({
        id: crypto.randomUUID(),
        taskId: task.id,
        type: 'TASK_INTERRUPTED',
        timestamp: Date.now(),
        data: {
          previousStatus: task.status,
          message: 'Server restarted before the task reached a terminal state',
        },
      });
    }

    return interrupted.length;
  }
}

function mapApproval(record: any): ApprovalRequestRecord {
  return {
    id: record.id,
    taskId: record.taskId,
    stepIndex: record.stepIndex,
    action: JSON.parse(record.actionJson) as Action,
    status: record.status as ApprovalStatus,
    reason: record.reason,
    requestedAt: Number(record.requestedAt),
    decidedAt: record.decidedAt === null ? null : Number(record.decidedAt),
  };
}

export class ApprovalRepository implements IApprovalRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createPending(input: CreateApprovalInput): Promise<ApprovalRequestRecord> {
    const record = await this.prisma.approvalRequest.create({
      data: {
        id: crypto.randomUUID(),
        taskId: input.taskId,
        stepIndex: input.stepIndex,
        actionJson: JSON.stringify(input.action),
        status: 'PENDING',
        reason: input.reason,
        requestedAt: BigInt(Date.now()),
      },
    });
    return mapApproval(record);
  }

  async getPending(taskId: string): Promise<ApprovalRequestRecord | null> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { taskId, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });
    return record ? mapApproval(record) : null;
  }

  async getById(id: string): Promise<ApprovalRequestRecord | null> {
    const record = await this.prisma.approvalRequest.findUnique({ where: { id } });
    return record ? mapApproval(record) : null;
  }

  async decide(
    id: string,
    decision: Exclude<ApprovalStatus, 'PENDING'>
  ): Promise<ApprovalRequestRecord | null> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: decision, decidedAt: BigInt(Date.now()) },
    });
    if (result.count !== 1) return null;
    return this.getById(id);
  }

  async listByTask(taskId: string): Promise<ApprovalRequestRecord[]> {
    const records = await this.prisma.approvalRequest.findMany({
      where: { taskId },
      orderBy: { requestedAt: 'asc' },
    });
    return records.map(mapApproval);
  }
}

export class EvidenceRepository implements IEvidenceRepository {
  private baseDir: string;
  private prisma?: PrismaClient;

  constructor(baseDir: string, prisma?: PrismaClient) {
    this.baseDir = path.resolve(baseDir);
    this.prisma = prisma;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async save(evidence: {
    id?: string;
    taskId: string;
    filename: string;
    type: string;
    timestamp: number;
    size?: number;
  }): Promise<void> {
    if (!this.prisma) return;
    const size = evidence.size ?? this.size(evidence.filename);
    await this.prisma.evidence.create({
      data: {
        id: evidence.id ?? crypto.randomUUID(),
        taskId: evidence.taskId,
        type: evidence.type,
        filename: evidence.filename,
        size,
        timestamp: BigInt(evidence.timestamp),
      },
    });
  }

  getFilePath(filename: string): string {
    return path.resolve(this.baseDir, filename);
  }

  exists(filename: string): boolean {
    return fs.existsSync(this.getFilePath(filename));
  }

  size(filename: string): number {
    try {
      return fs.statSync(this.getFilePath(filename)).size;
    } catch {
      return 0;
    }
  }
}
