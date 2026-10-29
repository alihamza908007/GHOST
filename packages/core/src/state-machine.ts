import { TaskStatus } from './types.js';

/**
 * Phase 2 additions are additive. Phase 1 transitions remain valid so the
 * deterministic path and its tests keep working.
 *
 * Per-action verification runs while the task is EXECUTING. The VERIFYING
 * status is reserved for the final verification phase, which keeps the
 * lifecycle compatible with Phase 1 (VERIFYING -> EXECUTING is not allowed).
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  IDLE: ['PLANNING', 'EXECUTING', 'CANCELLED'],
  PLANNING: ['PLAN_READY', 'FAILED', 'CANCELLED'],
  PLAN_READY: ['EXECUTING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'RETRYING', 'AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  RETRYING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['EXECUTING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  // Retained for Phase 1 compatibility. Capability degradation is tracked
  // separately in CapabilitySnapshot and does not gate the task lifecycle.
  DEGRADED: [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
