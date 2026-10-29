import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ExecutionEngine } from '../src/index.js';
import { DuplicateExecutionError } from '../src/errors.js';
import { ITaskRepository, IEvidenceRepository } from '@ghost/storage';
import { ActionPolicy, Task } from '@ghost/core';

function taskRepoMock(): ITaskRepository {
  return {
    create: vi.fn(),
    update: vi.fn(async () => undefined),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    addEvent: vi.fn(async () => undefined),
    getEvents: vi.fn(async () => []),
    recoverInterrupted: vi.fn(async () => 0),
  };
}

function evidenceRepoMock(): IEvidenceRepository {
  return {
    save: vi.fn(async () => undefined),
    getFilePath: vi.fn((filename: string) => `/tmp/${filename}`),
    exists: vi.fn(() => false),
    size: vi.fn(() => 0),
  };
}

const baseTask = (id = 'task-sec-1'): Task => ({
  id,
  objective: 'Try navigating to forbidden origin',
  status: 'IDLE',
  currentStepIndex: 0,
  lastEventId: null,
});

function recordedEvents(repo: ITaskRepository): Array<{
  type: string;
  data: Record<string, unknown>;
}> {
  const mock = repo.addEvent as unknown as {
    mock: { calls: Array<[unknown]> };
  };
  return mock.mock.calls.map(
    (call) => call[0] as { type: string; data: Record<string, unknown> }
  );
}

describe('@ghost/engine security boundary', () => {
  it('rejects navigation to unapproved origins before browser execution', async () => {
    const repo = taskRepoMock();
    const engine = new ExecutionEngine(
      repo,
      evidenceRepoMock(),
      'http://127.0.0.1:3001',
      '/tmp'
    );

    const task = baseTask();
    const plan = [
      { type: 'NAVIGATE' as const, payload: { url: 'https://evil.com/phish' } },
    ];

    const outcome = await engine.executePlan(task, plan);

    expect(outcome.status).toBe('failed');
    expect(task.status).toBe('FAILED');
    expect(repo.update).toHaveBeenCalledWith(
      'task-sec-1',
      expect.objectContaining({ status: 'FAILED' })
    );
    expect(repo.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'POLICY_REJECTION' })
    );
  });

  it('enforces the step budget before launching the browser', async () => {
    const repo = taskRepoMock();
    const engine = new ExecutionEngine(
      repo,
      evidenceRepoMock(),
      'http://127.0.0.1:3001',
      '/tmp'
    );
    const task = baseTask('task-budget');
    const steps = [
      {
        action: { type: 'NAVIGATE' as const, payload: { url: 'http://127.0.0.1:3001/' } },
        description: 'Open demo',
        expectation: { kind: 'visibleText' as const, value: 'GHOST' },
      },
      ...Array.from({ length: 8 }, () => ({
        action: {
          type: 'CLICK' as const,
          payload: { locator: { by: 'role' as const, role: 'button' as const, name: 'Go' } },
        },
        description: 'Click',
        expectation: { kind: 'visibleText' as const, value: 'Done' },
      })),
    ];

    const outcome = await engine.executePlan(task, steps as never);
    expect(outcome.status).toBe('failed');
    expect(repo.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'POLICY_REJECTION' })
    );
  });

  it('prevents duplicate concurrent execution of the same task', async () => {
    const repo = taskRepoMock();
    const engine = new ExecutionEngine(
      repo,
      evidenceRepoMock(),
      'http://127.0.0.1:3001',
      '/tmp'
    );
    const task = baseTask('task-duplicate');
    const plan = [
      { type: 'NAVIGATE' as const, payload: { url: 'https://evil.com/phish' } },
    ];

    const first = engine.executePlan(task, plan);
    await expect(engine.executePlan(task, plan)).rejects.toBeInstanceOf(
      DuplicateExecutionError
    );
    await first;
  });

  it('denies actions requiring approval when no approval store is configured', async () => {
    const repo = taskRepoMock();
    const policy = {
      allowedOrigin: 'http://127.0.0.1:3001',
      maxSteps: 8,
      maxActions: 15,
      maxNavigations: 3,
      validatePlan: () => ({ allowed: true, requiresApproval: false, approvalSteps: [], violations: [] }),
      evaluate: () => ({
        allowed: true,
        requiresApproval: true,
        code: 'SENSITIVE_FIELD',
        reason: 'sensitive',
      }),
    };
    const engine = new ExecutionEngine(
      repo,
      evidenceRepoMock(),
      'http://127.0.0.1:3001',
      '/tmp',
      { policy: policy as never, actionTimeoutMs: 500, taskTimeoutMs: 5_000 }
    );
    const task = baseTask('task-approval');
    const steps = [
      {
        action: { type: 'NAVIGATE' as const, payload: { url: 'http://127.0.0.1:3001/' } },
        description: 'Open demo',
        expectation: { kind: 'visibleText' as const, value: 'GHOST' },
      },
    ];

    // Policy says the NAVIGATE requires approval, and no approval repo exists.
    const outcome = await engine.executePlan(task, steps as never);
    expect(outcome.status).toBe('failed');
    expect(repo.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'POLICY_REJECTION' })
    );
  });

  it('re-checks policy immediately before every action', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<h1>Policy Demo</h1>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    const repo = taskRepoMock();
    const policy = new ActionPolicy({ allowedOrigin: origin });
    (policy as unknown as { validatePlan: () => unknown }).validatePlan = () => ({
      allowed: true,
      requiresApproval: false,
      approvalSteps: [],
      violations: [],
    });
    const realEvaluate = policy.evaluate.bind(policy);
    (policy as unknown as { evaluate: (action: unknown) => unknown }).evaluate = (
      action: unknown
    ) =>
      (action as { type: string }).type === 'SCREENSHOT'
        ? {
            allowed: false,
            requiresApproval: false,
            code: 'INVALID_ACTION',
            reason: 'Screenshot denied by per-action policy',
          }
        : realEvaluate(action as never);

    const engine = new ExecutionEngine(repo, evidenceRepoMock(), origin, '/tmp', {
      policy,
      actionTimeoutMs: 5_000,
      taskTimeoutMs: 10_000,
    });
    const task = baseTask('task-per-action');
    const steps = [
      {
        action: { type: 'NAVIGATE' as const, payload: { url: `${origin}/` } },
        description: 'Open policy demo',
        expectation: { kind: 'visibleText' as const, value: 'Policy Demo' },
      },
      {
        action: { type: 'SCREENSHOT' as const, payload: { name: 'result' } },
        description: 'Capture result',
        expectation: { kind: 'screenshot' as const },
      },
    ];

    const outcome = await engine.executePlan(task, steps as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(outcome.status).toBe('failed');
    const events = recordedEvents(repo);
    const started = events.filter((event) => event.type === 'ACTION_STARTED');
    expect(started).toHaveLength(1);
    expect(started[0].data.actionType).toBe('NAVIGATE');
    expect(
      events.some(
        (event) =>
          event.type === 'POLICY_REJECTION' && event.data.stepIndex === 1
      )
    ).toBe(true);
  });

  it('rejects redirects to an unapproved origin', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(302, { location: 'https://example.com/' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    const repo = taskRepoMock();
    const engine = new ExecutionEngine(repo, evidenceRepoMock(), origin, '/tmp', {
      actionTimeoutMs: 5_000,
      taskTimeoutMs: 10_000,
    });
    const task = baseTask('task-redirect');
    const steps = [
      {
        action: { type: 'NAVIGATE' as const, payload: { url: `${origin}/redirect` } },
        description: 'Follow redirect',
        expectation: { kind: 'visibleText' as const, value: 'Never' },
      },
    ];

    const outcome = await engine.executePlan(task, steps as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(outcome.status).toBe('failed');
    const events = recordedEvents(repo);
    expect(events.some((event) => event.type === 'POLICY_REJECTION')).toBe(true);
  });

  it('rejects popups opened by page interactions', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<h1>Popup Demo</h1><button onclick="window.open(\'https://example.com/\')">Open popup</button>'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    const repo = taskRepoMock();
    const engine = new ExecutionEngine(repo, evidenceRepoMock(), origin, '/tmp', {
      actionTimeoutMs: 5_000,
      taskTimeoutMs: 10_000,
    });
    const task = baseTask('task-popup');
    const steps = [
      {
        action: { type: 'NAVIGATE' as const, payload: { url: `${origin}/` } },
        description: 'Open popup demo',
        expectation: { kind: 'visibleText' as const, value: 'Popup Demo' },
      },
      {
        action: {
          type: 'CLICK' as const,
          payload: {
            locator: { by: 'role' as const, role: 'button' as const, name: 'Open popup' },
          },
        },
        description: 'Open a popup',
        expectation: { kind: 'visibleText' as const, value: 'Opened' },
      },
    ];

    const outcome = await engine.executePlan(task, steps as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(outcome.status).toBe('failed');
    const events = recordedEvents(repo);
    expect(events.some((event) => event.type === 'POLICY_REJECTION')).toBe(true);
  });
});
