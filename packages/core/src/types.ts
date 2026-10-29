import type { Plan } from './schema.js';

export type TaskStatus =
  | 'IDLE'
  | 'PLANNING'
  | 'PLAN_READY'
  | 'EXECUTING'
  | 'VERIFYING'
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

export interface VerificationResult {
  outcome: VerificationOutcome;
  method: string;
  detail: string;
  expectationKind?: string;
  evidenceRef?: string;
  timestamp: number;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

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
}

export interface ExecutionOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  error?: string;
  executedActions: number;
}
