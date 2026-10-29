export class PolicyViolationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyViolationError';
    this.code = code;
  }
}

export class VerificationError extends Error {
  readonly outcome: string;
  constructor(message: string, outcome = 'failed') {
    super(message);
    this.name = 'VerificationError';
    this.outcome = outcome;
  }
}

export class CancelledError extends Error {
  constructor(message = 'Task was cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

export class DuplicateExecutionError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} is already executing`);
    this.name = 'DuplicateExecutionError';
  }
}
