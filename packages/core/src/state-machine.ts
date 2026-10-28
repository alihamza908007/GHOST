import { TaskStatus } from './types.js';

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  IDLE: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  DEGRADED: [] // Should not be a task status, but a capability flag
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
