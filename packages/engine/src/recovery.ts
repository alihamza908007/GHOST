import {
  ActionPolicy,
  Locator,
  RecoveryAction,
  Task,
  VisualEvaluation,
  VerificationResult,
  NO_RECOVERY_STATUSES,
} from '@ghost/core';

export interface RecoveryDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
  action?: RecoveryAction;
}

export interface RecoveryEvaluationInput {
  task: Task;
  verification: VerificationResult;
  visual: VisualEvaluation;
  policy: ActionPolicy;
  allowedOrigin: string;
  allowedOrigins?: string[];
  recoveryCloseAllowlist: string[];
  recoveryAttemptsUsed: number;
  retriesForAction: number;
  failedStepIndex?: number;
  /** Optional suggested close-control; defaults to the first allowlisted control. */
  recoveryCloseCandidate?: string;
}

function makeDismissLocator(allowlist: string[]): Locator | undefined {
  const entry = allowlist.find((item) => typeof item === 'string' && item.trim().length > 0);
  if (!entry) return undefined;
  const trimmed = entry.trim();
  if (trimmed.toLowerCase().startsWith('testid:')) {
    const testId = trimmed.slice('testid:'.length).trim();
    if (!testId) return undefined;
    return { by: 'testId', testId };
  }
  return { by: 'role', role: 'button', name: trimmed };
}

/**
 * Conservative, evidence-driven recovery eligibility check. Recovery may only
 * run while the task is EXECUTING or VERIFYING, inside the hard recovery budget,
 * and only for a failed or inconclusive verification. Every candidate recovery
 * action still has to pass the policy gate; nothing here can widen limits.
 */
export function evaluateRecovery(input: RecoveryEvaluationInput): RecoveryDecision {
  const statusBlocked = new Set<string>([...NO_RECOVERY_STATUSES, 'AWAITING_APPROVAL']);
  if (statusBlocked.has(input.task.status)) {
    return {
      allowed: false,
      code: 'RECOVERY_BLOCKED',
      reason: `Recovery is not permitted while task status is ${input.task.status}`,
    };
  }
  if (input.task.status !== 'EXECUTING' && input.task.status !== 'VERIFYING') {
    return {
      allowed: false,
      code: 'RECOVERY_BLOCKED',
      reason: `Recovery is not permitted while task status is ${input.task.status}`,
    };
  }

  const verificationPassed = input.verification.outcome === 'passed';
  if (verificationPassed) {
    return {
      allowed: false,
      code: 'RECOVERY_NOT_NEEDED',
      reason: 'Verification passed; no recovery is required',
    };
  }

  if (input.recoveryAttemptsUsed >= input.policy.maxRecoveryAttempts) {
    return {
      allowed: false,
      code: 'RECOVERY_BUDGET_EXHAUSTED',
      reason: `Recovery budget of ${input.policy.maxRecoveryAttempts} was exhausted`,
    };
  }

  const observation = input.visual?.observation;
  const visualAvailable = input.visual?.available === true && observation !== undefined;

  const decision: RecoveryDecision = {
    allowed: false,
    code: 'RECOVERY_NOT_AUTHORIZED',
    reason: 'No authorized recovery action was justified by the evidence',
  };

  const candidate = input.recoveryCloseCandidate ?? input.recoveryCloseAllowlist[0];
  const dismissLocator = visualAvailable && candidate ? makeDismissLocator([candidate]) : undefined;
  const obstructionJustified =
    !!observation && observation.obstructions.length > 0 && !!dismissLocator;

  if (obstructionJustified && dismissLocator) {
    const auth = input.policy.authorizeRecovery(
      { kind: 'DISMISS_OVERLAY', locator: dismissLocator },
      { allowedOrigins: input.allowedOrigins ?? [input.allowedOrigin], recoveryCloseAllowlist: input.recoveryCloseAllowlist }
    );
    if (auth.allowed) {
      decision.allowed = true;
      decision.code = 'RECOVERY_DISMISSED';
      decision.reason = 'Overlay dismissal was authorized by the recovery allowlist';
      decision.action = { kind: 'DISMISS_OVERLAY', locator: dismissLocator };
    } else {
      decision.code = auth.code ?? 'RECOVERY_UNAUTHORIZED';
      decision.reason = auth.reason ?? 'Overlay dismissal was rejected by policy';
    }
  }

  const canRetry =
    !decision.action &&
    input.failedStepIndex !== undefined &&
    input.retriesForAction < input.policy.maxRetriesPerAction &&
    !!observation &&
    observation.expectedCondition === 'absent';
  if (canRetry && input.failedStepIndex !== undefined) {
    decision.allowed = true;
    decision.code = 'RETRY_AUTHORIZED';
    decision.reason = 'Deterministic failure with visual evidence justified a retry';
    decision.action = { kind: 'RETRY', stepIndex: input.failedStepIndex };
  }

  return decision;
}
