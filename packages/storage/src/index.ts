import { Task, TaskEvent, TaskStatus, TaskEventType } from '@ghost/core';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';

export interface ITaskRepository {
  create(task: Task): Promise<void>;
  update(id: string, updates: Partial<Task>): Promise<void>;
  getById(id: string): Promise<Task | null>;
  addEvent(event: TaskEvent): Promise<void>;
  getEvents(taskId: string): Promise<TaskEvent[]>;
}

export interface IEvidenceRepository {
  save(evidence: { taskId: string; filename: string; type: string; timestamp: number }): Promise<void>;
  getFilePath(filename: string): string;
  exists(filename: string): boolean;
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
        status: task.status as any,
        currentStepIndex: task.currentStepIndex,
        lastEventId: task.lastEventId,
      }
    });
  }

  async update(id: string, updates: Partial<Task>): Promise<void> {
    const updateable = { ...updates } as any;
    // Cast status to the correct enum type if necessary
    if ('status' in updateable) {
        updateable.status = updateable.status as any;
    }
    await this.prisma.task.update({
      where: { id },
      data: updateable,
    });
  }

  async getById(id: string): Promise<Task | null> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { events: true }
    });
    if (!task) return null;

    return {
      ...task,
      status: task.status as any,
    } as any;
  }

  async addEvent(event: TaskEvent): Promise<void> {
    await this.prisma.taskEvent.create({
      data: {
        id: event.id,
        taskId: event.taskId,
        type: event.type as any,
        timestamp: BigInt(event.timestamp),
        data: JSON.stringify(event.data),
      }
    });
  }

  async getEvents(taskId: string): Promise<TaskEvent[]> {
    const events = await this.prisma.taskEvent.findMany({
      where: { taskId },
      orderBy: { timestamp: 'asc' }
    });
    return events.map((e: any) => ({
      ...e,
      type: e.type as any,
      timestamp: Number(e.timestamp),
      data: JSON.parse(e.data)
    } as any) as TaskEvent);
  }
}

export class EvidenceRepository implements IEvidenceRepository {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async save(evidence: { taskId: string; filename: string; type: string; timestamp: number }): Promise<void> {
    // In this phase, the engine writes the file directly, 
    // but we use this to keep tracking if needed.
  }

  getFilePath(filename: string): string {
    return path.resolve(this.baseDir, filename);
  }

  exists(filename: string): boolean {
    return fs.existsSync(this.getFilePath(filename));
  }
}
