import { describe, it, expect, vi } from 'vitest';
import { ExecutionEngine } from '../src/index.js';
import { ITaskRepository, IEvidenceRepository } from '@ghost/storage';
import { Task } from '@ghost/core';

describe('@ghost/engine ExecutionEngine', () => {
  const mockTaskRepo: ITaskRepository = {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    addEvent: vi.fn(),
    getEvents: vi.fn(),
  };

  const mockEvidenceRepo: IEvidenceRepository = {
    save: vi.fn(),
    getFilePath: vi.fn(),
    exists: vi.fn(),
  };

  it('rejects navigation to unapproved origins', async () => {
    const allowedOrigin = 'http://127.0.0.1:3001';
    const engine = new ExecutionEngine(
      mockTaskRepo,
      mockEvidenceRepo,
      allowedOrigin,
      '/tmp'
    );

    const task: Task = {
      id: 'task-sec-1',
      objective: 'Try navigating to forbidden origin',
      status: 'IDLE',
      currentStepIndex: 0,
      lastEventId: null,
    };

    const plan = [
      { type: 'NAVIGATE' as const, payload: { url: 'https://evil.com/phish' } },
    ];

    await engine.executePlan(task, plan);

    expect(task.status).toBe('FAILED');
    expect(mockTaskRepo.update).toHaveBeenCalledWith('task-sec-1', { status: 'FAILED' });
  });
});
