import { describe, expect, it } from 'vitest';
import { ActionPolicy, Task, TaskStatus, VisualCondition, VisualEvaluation, VerificationResult } from '@ghost/core';
import { combineVerification } from '../src/verification.js';
import { evaluateRecovery } from '../src/recovery.js';

const allowedOrigin = 'http://127.0.0.1:3001';

function failedVerification(detail = 'Expected element was not visible'): VerificationResult {
  return {
    outcome: 'failed',
    method: 'dom-element-visible',
    detail,
    expectationKind: 'elementVisible',
    timestamp: Date.now(),
  };
}

function passedVerification(): VerificationResult {
  return {
    outcome: 'passed',
    method: 'dom-element-visible',
    detail: 'Expected element was visible',
    expectationKind: 'elementVisible',
    timestamp: Date.now(),
  };
}

function visualWith(
  expectedCondition: VisualCondition,
  obstructions: string[] = []
): VisualEvaluation {
  return {
    available: true,
    observation: {
      summary: 'A condition was observed',
      expectedCondition,
      obstructions,
      explanation: 'A bounded diagnostic explanation',
    },
    agreed: true,
  };
}

function unavailableVisual(): VisualEvaluation {
  return { available: false, error: 'VISUAL_UNAVAILABLE' };
}

describe('@ghost/engine conservative visual verification combination', () => {
  it('keeps a deterministic success authoritative even when vision is available', () => {
    const combined = combineVerification(passedVerification(), visualWith('present'), 'task-1', 0);
    expect(combined.outcome).toBe('passed');
    expect(combined.visual?.available).toBe(true);
  });

  it('keeps a deterministic success authoritative when vision is unavailable', () => {
    const combined = combineVerification(passedVerification(), unavailableVisual(), 'task-1', 0);
    expect(combined.outcome).toBe('passed');
    expect(combined.visual?.available).toBe(false);
  });

  it('never lets a positive visual description override a deterministic failure', () => {
    const combined = combineVerification(failedVerification(), visualWith('present'), 'task-1', 0);
    expect(combined.outcome).toBe('inconclusive');
    expect(combined.visual?.agreed).toBe(false);
    expect(combined.method).toContain('+visual');
  });

  it('accepts a consistent deterministic failure with absent visual evidence', () => {
    const combined = combineVerification(failedVerification(), visualWith('absent'), 'task-1', 0);
    expect(combined.outcome).toBe('failed');
    expect(combined.visual?.agreed).toBe(true);
  });

  it('keeps uncertain vision inconclusive for a failed deterministic check', () => {
    const combined = combineVerification(failedVerification(), visualWith('uncertain'), 'task-1', 0);
    expect(combined.outcome).toBe('inconclusive');
  });

  it('preserves a failed deterministic outcome when vision is unavailable', () => {
    const combined = combineVerification(failedVerification(), unavailableVisual(), 'task-1', 0);
    expect(combined.outcome).toBe('failed');
  });
});

describe('@ghost/engine bounded recovery controller', () => {
  const policy = new ActionPolicy({
    allowedOrigin: allowedOrigin,
    maxRecoveryAttempts: 2,
    maxRetriesPerAction: 1,
  });

  const runningTask = (status: TaskStatus = 'EXECUTING'): Task => ({
    id: 'task-rec-1',
    objective: 'Show the message',
    status,
    currentStepIndex: 1,
    lastEventId: null,
  });

  it('authorizes a policy-approved overlay dismissal driven by visual obstructions', () => {
    const decision = evaluateRecovery({
      task: runningTask(),
      verification: failedVerification(),
      visual: {
        available: true,
        observation: {
          summary: 'Overlay blocks the target',
          expectedCondition: 'present',
          obstructions: ['overlay'],
          explanation: 'The overlay covers the target',
        },
      },
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 0,
      retriesForAction: 0,
      failedStepIndex: 1,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.action?.kind).toBe('DISMISS_OVERLAY');
  });

  it('rejects overlay dismissal that is not on the recovery allowlist', () => {
    const decision = evaluateRecovery({
      task: runningTask(),
      verification: failedVerification(),
      visual: {
        available: true,
        observation: {
          summary: 'Overlay blocks the target',
          expectedCondition: 'present',
          obstructions: ['overlay'],
          explanation: 'The overlay covers the target',
        },
      },
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 0,
      retriesForAction: 0,
      failedStepIndex: 1,
      recoveryCloseCandidate: 'NotOnList',
    });

    expect(decision.allowed).toBe(false);
  });

  it('authorizes a retry only within the retry budget', () => {
    const baseInput: Parameters<typeof evaluateRecovery>[0] = {
      task: runningTask(),
      verification: failedVerification(),
      visual: {
        available: true,
        observation: {
          summary: 'Expected success indicator absent',
          expectedCondition: 'absent',
          obstructions: [],
          explanation: 'The success indicator was not rendered',
        },
      },
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 0,
      retriesForAction: 0,
      failedStepIndex: 1,
    };

    const authorized = evaluateRecovery({ ...baseInput, retriesForAction: 0 });
    expect(authorized.allowed).toBe(true);
    expect(authorized.action?.kind).toBe('RETRY');

    const exhausted = evaluateRecovery({ ...baseInput, retriesForAction: 1 });
    expect(exhausted.allowed).toBe(false);
  });

  it('stops recovery for terminal task states and after verified success', () => {
    const blocked = evaluateRecovery({
      task: { ...runningTask(), status: 'COMPLETED' },
      verification: failedVerification(),
      visual: unavailableVisual(),
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 0,
      retriesForAction: 0,
      failedStepIndex: 1,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('RECOVERY_BLOCKED');

    const notNeeded = evaluateRecovery({
      task: runningTask(),
      verification: passedVerification(),
      visual: unavailableVisual(),
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 0,
      retriesForAction: 0,
      failedStepIndex: 1,
    });
    expect(notNeeded.allowed).toBe(false);
    expect(notNeeded.code).toBe('RECOVERY_NOT_NEEDED');
  });

  it('enforces the hard per-task recovery budget', () => {
    const decision = evaluateRecovery({
      task: runningTask(),
      verification: failedVerification(),
      visual: unavailableVisual(),
      policy,
      allowedOrigin: allowedOrigin,
      recoveryCloseAllowlist: ['Close'],
      recoveryAttemptsUsed: 2,
      retriesForAction: 0,
      failedStepIndex: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('RECOVERY_BUDGET_EXHAUSTED');
  });
});
