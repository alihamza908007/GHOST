import { describe, expect, it } from 'vitest';
import { ActionPolicy, Task, TaskStatus, VerificationResult, VisualEvaluation } from '@ghost/core';
import { combineVerification } from '../src/verification.js';
import { evaluateRecovery } from '../src/recovery.js';

const origin = 'http://127.0.0.1:3001';

function verification(outcome: VerificationResult['outcome']): VerificationResult {
  return {
    outcome,
    method: 'dom-test',
    detail: `dom ${outcome}`,
    expectationKind: 'elementVisible',
    timestamp: Date.now(),
  };
}

function visual(expectedCondition: VisualEvaluation['observation'] extends infer T
  ? T extends { expectedCondition: infer E } ? E : never
  : never, available = true): VisualEvaluation {
  if (!available) return { available: false, error: 'VISUAL_UNAVAILABLE' };
  return {
    available: true,
    observation: {
      summary: 'visual diagnostic',
      expectedCondition: expectedCondition as 'present' | 'absent' | 'uncertain',
      obstructions: [],
      explanation: 'bounded',
    },
    agreed: expectedCondition !== 'present',
  };
}

describe('@ghost/engine hardening: combineVerification truth table', () => {
  const outcomes: Array<VerificationResult['outcome']> = ['passed', 'failed', 'inconclusive'];
  const visuals: Array<'present' | 'absent' | 'uncertain' | 'unavailable'> = ['present', 'absent', 'uncertain', 'unavailable'];

  for (const d of outcomes) {
    for (const v of visuals) {
      it(`deterministic=${d}, visual=${v}`, () => {
        const vis = v === 'unavailable' ? visual('present', false) : visual(v as 'present' | 'absent' | 'uncertain', true);
        const combined = combineVerification(verification(d), vis, 't', 0);

        // Invariant: deterministic pass is always success.
        if (d === 'passed') {
          expect(combined.outcome).toBe('passed');
          return;
        }
        // Invariant: deterministic failure + positive visual never becomes success.
        if (d === 'failed' && v === 'present') {
          expect(combined.outcome).not.toBe('passed');
          expect(combined.outcome).toBe('inconclusive');
          return;
        }
        // Invariant: a screenshot/visual alone never establishes success.
        expect(combined.outcome).not.toBe('passed');
        // Invariant: missing visual is not positive evidence.
        if (v === 'unavailable') {
          expect(combined.outcome).toBe(d === 'failed' ? 'failed' : 'inconclusive');
        }
      });
    }
  }

  it('deterministic pass stays passed even when visual reports absent', () => {
    const combined = combineVerification(verification('passed'), visual('absent'), 't', 0);
    expect(combined.outcome).toBe('passed');
  });

  it('deterministic pass stays passed when visual is unavailable', () => {
    const combined = combineVerification(verification('passed'), visual('present', false), 't', 0);
    expect(combined.outcome).toBe('passed');
  });

  it('inconclusive DOM + positive visual stays inconclusive', () => {
    const combined = combineVerification(verification('inconclusive'), visual('present'), 't', 0);
    expect(combined.outcome).toBe('inconclusive');
  });

  it('failed DOM + absent visual stays failed', () => {
    const combined = combineVerification(verification('failed'), visual('absent'), 't', 0);
    expect(combined.outcome).toBe('failed');
  });

  it('failed DOM + uncertain visual becomes inconclusive', () => {
    const combined = combineVerification(verification('failed'), visual('uncertain'), 't', 0);
    expect(combined.outcome).toBe('inconclusive');
  });

  it('preserves taskId and stepIndex on combined result', () => {
    const combined = combineVerification(verification('failed'), visual('absent'), 'task-42', 7);
    expect(combined.taskId).toBe('task-42');
    expect(combined.stepIndex).toBe(7);
  });
});

describe('@ghost/engine hardening: recovery limit bypass attempts', () => {
  const policy = new ActionPolicy({ allowedOrigin: origin, maxRecoveryAttempts: 2, maxRetriesPerAction: 1 });

  function task(status: TaskStatus = 'EXECUTING'): Task {
    return { id: 't', objective: 'o', status, currentStepIndex: 1, lastEventId: null };
  }

  function failedV(): VerificationResult {
    return { outcome: 'failed', method: 'm', detail: 'd', expectationKind: 'elementVisible', timestamp: Date.now() };
  }

  function vis(): VisualEvaluation {
    return { available: true, observation: { summary: 's', expectedCondition: 'absent', obstructions: [], explanation: 'e' } };
  }

  it('blocks recovery at exactly the budget (2 used)', () => {
    const d = evaluateRecovery({ task: task(), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 2, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_BUDGET_EXHAUSTED');
  });

  it('allows recovery at 1 used (one remaining)', () => {
    const d = evaluateRecovery({ task: task(), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 1, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(true);
  });

  it('blocks a second retry of the same action', () => {
    const base = { task: task(), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, failedStepIndex: 1 };
    const first = evaluateRecovery({ ...base, retriesForAction: 0 });
    expect(first.allowed).toBe(true);
    expect(first.action?.kind).toBe('RETRY');
    const second = evaluateRecovery({ ...base, retriesForAction: 1 });
    expect(second.allowed).toBe(false);
  });

  it('blocks recovery after verified success', () => {
    const d = evaluateRecovery({ task: task(), verification: { outcome: 'passed', method: 'm', detail: 'd', expectationKind: 'elementVisible', timestamp: Date.now() }, visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_NOT_NEEDED');
  });

  it('blocks recovery for cancelled task', () => {
    const d = evaluateRecovery({ task: task('CANCELLED'), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_BLOCKED');
  });

  it('blocks recovery for failed task', () => {
    const d = evaluateRecovery({ task: task('FAILED'), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_BLOCKED');
  });

  it('blocks recovery for completed task', () => {
    const d = evaluateRecovery({ task: task('COMPLETED'), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_BLOCKED');
  });

  it('does not authorize overlay dismissal without obstructions', () => {
    const v: VisualEvaluation = { available: true, observation: { summary: 's', expectedCondition: 'present', obstructions: [], explanation: 'e' } };
    const d = evaluateRecovery({ task: task(), verification: failedV(), visual: v, policy, allowedOrigin: origin, recoveryCloseAllowlist: ['Close'], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    // Without obstructions, dismiss not justified; retry requires expectedCondition 'absent' — here 'present', so not authorized.
    expect(d.allowed).toBe(false);
  });

  it('does not authorize retry when visual reports present (disagreement)', () => {
    const v: VisualEvaluation = { available: true, observation: { summary: 's', expectedCondition: 'present', obstructions: [], explanation: 'e' } };
    const d = evaluateRecovery({ task: task(), verification: failedV(), visual: v, policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
  });

  it('recovery cannot exceed maxRecoveryAttempts even if requested', () => {
    const d = evaluateRecovery({ task: task(), verification: failedV(), visual: vis(), policy, allowedOrigin: origin, recoveryCloseAllowlist: [], recoveryAttemptsUsed: 100, retriesForAction: 0, failedStepIndex: 1 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('RECOVERY_BUDGET_EXHAUSTED');
  });
});

describe('@ghost/engine hardening: recovery overlay authorization', () => {
  const policy = new ActionPolicy({ allowedOrigin: origin, maxRecoveryAttempts: 2, maxRetriesPerAction: 1 });

  it('authorizes only allowlisted close control', () => {
    const task: Task = { id: 't', objective: 'o', status: 'EXECUTING', currentStepIndex: 1, lastEventId: null };
    const failedV: VerificationResult = { outcome: 'failed', method: 'm', detail: 'd', expectationKind: 'elementVisible', timestamp: Date.now() };
    const vis: VisualEvaluation = { available: true, observation: { summary: 's', expectedCondition: 'present', obstructions: ['overlay'], explanation: 'e' } };

    const authorized = evaluateRecovery({ task, verification: failedV, visual: vis, policy, allowedOrigin: origin, recoveryCloseAllowlist: ['Close'], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1 });
    expect(authorized.allowed).toBe(true);
    expect(authorized.action?.kind).toBe('DISMISS_OVERLAY');

    const unauthorized = evaluateRecovery({ task, verification: failedV, visual: vis, policy, allowedOrigin: origin, recoveryCloseAllowlist: ['Close'], recoveryAttemptsUsed: 0, retriesForAction: 0, failedStepIndex: 1, recoveryCloseCandidate: 'NotAName' });
    expect(unauthorized.allowed).toBe(false);
  });
});
