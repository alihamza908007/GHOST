import type { Plan } from './schema.js';

export type TaskStatus =
  | 'IDLE'
  | 'PLANNING'
  | 'PLAN_READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'RETRYING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DEGRADED';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses from which no further recovery work may be scheduled. */
export const NO_RECOVERY_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DEGRADED',
];

export interface Task {
  id: string;
  objective: string;
  status: TaskStatus;
  currentStepIndex: number;
  lastEventId: string | null;
  /** Validated plan persisted for display and restart-safe history. */
  plan?: Plan | null;
  planSummary?: string | null;
  plannerModel?: string | null;
  /** Approved origins for this task (multi-origin). */
  approvedOrigins?: string[] | null;
  researchFields?: Array<{ name: string; type: string; description?: string }> | null;
  researchBudget?: number | null;
  researchResultJson?: string | null;
  /** Safe, user-facing failure reason. Never contains prompts or secrets. */
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export type TaskEventType =
  | 'TASK_CREATED'
  | 'PLANNING_STARTED'
  | 'PLANNING_COMPLETED'
  | 'PLAN_VALIDATION_FAILED'
  | 'PLAN_READY'
  | 'ACTION_STARTED'
  | 'ACTION_FINISHED'
  | 'VERIFICATION_RESULT'
  | 'VISUAL_OBSERVATION_STARTED'
  | 'ORIGIN_TRANSITION'
  | 'VISUAL_OBSERVATION_COMPLETED'
  | 'VISUAL_UNAVAILABLE'
  | 'DOM_VISUAL_DISAGREEMENT'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_COMPLETED'
  | 'RETRY_AUTHORIZED'
  | 'RETRY_REJECTED'
  | 'RECOVERY_BUDGET_EXHAUSTED'
  | 'POLICY_REJECTION'
  | 'MODEL_ERROR'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'TASK_CANCELLED'
  | 'TASK_COMPLETED'
  | 'TASK_INTERRUPTED'
  | 'ERROR';

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  timestamp: number;
  /** Monotonic per-task ordering assigned by the repository. */
  seq?: number;
  data: Record<string, unknown>;
}

export type VerificationOutcome = 'passed' | 'failed' | 'inconclusive';

/**
 * Coarse visual condition the observer was asked about. The observer may only
 * ever *describe* visibility; deterministic code decides what counts as proof.
 */
export type VisualCondition = 'present' | 'absent' | 'uncertain';

export interface VisualObservation {
  summary: string;
  expectedCondition: VisualCondition;
  obstructions: string[];
  explanation: string;
  /** Optional confidence metadata; never used as sole proof of success. */
  confidence?: number;
}

export interface VisualObservationInput {
  taskId: string;
  /** Base64-encoded PNG/JPEG screenshot from the task evidence store. */
  screenshotBase64?: string;
  expectedCondition: VisualCondition;
  actionContext: string;
  domObservations?: string[];
}

export interface VisualEvaluation {
  available: boolean;
  observation?: VisualObservation;
  error?: string;
  /** Whether deterministic evidence and visual evidence agreed. */
  agreed?: boolean;
}

export interface VerificationResult {
  outcome: VerificationOutcome;
  method: string;
  detail: string;
  expectationKind?: string;
  evidenceRef?: string;
  timestamp: number;
  taskId?: string;
  stepIndex?: number;
  screenshotRef?: string;
  /** Visual evaluation used to combine DOM evidence with perception. */
  visual?: VisualEvaluation;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Narrow, policy-authorized recovery operations. Recovery never invents new
 * actions outside this catalog and never bypasses the policy engine.
 */
export type RecoveryAction =
  | { kind: 'DISMISS_OVERLAY'; locator: import('./schema.js').Locator }
  | { kind: 'RETRY'; stepIndex: number };

export interface ApprovalRequestRecord {
  id: string;
  taskId: string;
  stepIndex: number;
  action: import('./schema.js').Action;
  status: ApprovalStatus;
  reason: string;
  requestedAt: number;
  decidedAt?: number | null;
}

/**
 * Capability information is deliberately separate from task lifecycle. A task
 * can be COMPLETED while the planner's vision capability is unavailable.
 */
export interface CapabilitySnapshot {
  plannerModel: string;
  connected: boolean;
  modelAvailable: boolean;
  textGeneration: boolean;
  structuredOutput: boolean;
  vision: boolean;
  degradedFeatures: string[];
  lastErrorCode?: string;
  checkedAt: number;
  /** Local vision model reported by the vision observer/provider. */
  visionModel?: string;
  visionConnected?: boolean;
  visionLastErrorCode?: string;
}

export interface ExecutionOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  error?: string;
  executedActions: number;
}

export interface ExecutionLimits {
  maxRecoveryAttempts: number;
  maxRetriesPerAction: number;
}

/**
 * Minimal structural contract the browser engine uses for optional local
 * visual perception. The engine never imports the model provider; the server
 * wires the concrete observer in.
 */
export interface VisualObserverLike {
  readonly name: string;
  readonly model: string;
  observe(input: VisualObservationInput): Promise<VisualObservation>;
}

export interface SkillInput {
  name: string;
  description: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  inputs: SkillInput[];
  steps: Array<{
    action: any;
    description: string;
    expectation: any;
  }>;
  preconditions?: string;
  postconditions?: string;
  verificationStrategy?: string;
  createdAt?: number;
}
