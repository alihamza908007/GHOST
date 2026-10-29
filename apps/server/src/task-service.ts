import {
  ActionPolicy,
  ApprovalRequestRecord,
  ExecutionOutcome,
  LIMITS,
  Plan,
  Task,
  TaskEvent,
  TaskEventType,
  actionsEqual,
  isTerminalStatus,
} from '@ghost/core';
import { IApprovalRepository, ITaskRepository } from '@ghost/storage';
import {
  PlanningError,
  PlanningContext,
  PlannerResult,
} from '@ghost/models';
import crypto from 'crypto';

export interface PlannerLike {
  plan(
    context: PlanningContext,
    options: { requestId: string; signal?: AbortSignal }
  ): Promise<PlannerResult>;
  cancel?(requestId: string): void;
}

export interface EngineLike {
  executePlan(
    task: Task,
    plan: Plan,
    options?: {
      startIndex?: number;
      approval?: { approvalId: string; stepIndex: number };
    }
  ): Promise<ExecutionOutcome>;
  discardPausedSession?(taskId: string): Promise<void>;
}

export class ServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TaskServiceOptions {
  taskRepo: ITaskRepository;
  approvalRepo: IApprovalRepository;
  planner: PlannerLike;
  engine: EngineLike;
  policy: ActionPolicy;
  plannerModel: string;
  observationProvider?: () => Promise<string[]>;
}

export class TaskService {
  private readonly taskRepo: ITaskRepository;
  private readonly approvalRepo: IApprovalRepository;
  private readonly planner: PlannerLike;
  private readonly engine: EngineLike;
  private readonly policy: ActionPolicy;
  private readonly plannerModel: string;
  private readonly observationProvider?: () => Promise<string[]>;
  private readonly active = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: TaskServiceOptions) {
    this.taskRepo = options.taskRepo;
    this.approvalRepo = options.approvalRepo;
    this.planner = options.planner;
    this.engine = options.engine;
    this.policy = options.policy;
    this.plannerModel = options.plannerModel;
    this.observationProvider = options.observationProvider;
  }

  async startTask(objective: string): Promise<Task> {
    const cleaned = objective.trim();
    if (cleaned.length === 0) {
      throw new ServiceError('INVALID_OBJECTIVE', 'An objective is required');
    }
    if (cleaned.length > LIMITS.MAX_OBJECTIVE_CHARS) {
      throw new ServiceError(
        'INVALID_OBJECTIVE',
        `Objective must be at most ${LIMITS.MAX_OBJECTIVE_CHARS} characters`
      );
    }

    const task: Task = {
      id: crypto.randomUUID(),
      objective: cleaned,
      status: 'PLANNING',
      currentStepIndex: 0,
      lastEventId: null,
      plan: null,
      planSummary: null,
      plannerModel: this.plannerModel,
      error: null,
    };

    await this.taskRepo.create(task);
    await this.createEvent(task.id, 'TASK_CREATED', { objective: cleaned });

    // Fire and forget; the API returns immediately so the dashboard can show
    // the PLANNING stage via polling.
    void this.runTask(task).catch(() => undefined);
    return (await this.taskRepo.getById(task.id)) ?? task;
  }

  async runTask(task: Task): Promise<ExecutionOutcome | null> {
    if (this.active.has(task.id)) {
      throw new ServiceError('DUPLICATE_EXECUTION', 'Task is already running', 409);
    }
    this.active.add(task.id);
    const abort = new AbortController();
    this.aborts.set(task.id, abort);

    try {
      const fresh = await this.taskRepo.getById(task.id);
      if (!fresh || fresh.status === 'CANCELLED' || isTerminalStatus(fresh.status)) {
        return null;
      }

      await this.createEvent(task.id, 'PLANNING_STARTED', {
        model: this.plannerModel,
        maxSteps: LIMITS.MAX_PLAN_STEPS,
        maxActions: LIMITS.MAX_EXECUTED_ACTIONS,
        maxAttempts: LIMITS.MAX_PLANNER_ATTEMPTS,
      });

      const observations = await this.safeObservations();
      const result = await this.planner.plan(
        {
          objective: fresh.objective,
          observations,
        },
        { requestId: task.id, signal: abort.signal }
      );

      // A cancellation may land while the model is responding.
      const afterPlanning = await this.taskRepo.getById(task.id);
      if (!afterPlanning || afterPlanning.status === 'CANCELLED') {
        return { status: 'cancelled', executedActions: 0 };
      }

      const plan = result.plan;
      const policyResult = this.policy.validatePlan(plan, {
        objective: fresh.objective,
      });
      if (!policyResult.allowed) {
        // Defence in depth: the planner validated already, but execution never
        // trusts a plan that changed after validation.
        throw new PlanningError(
          'POLICY_VIOLATION',
          'The plan failed final policy validation',
          result.attempts,
          policyResult.violations.map((item) => item.message)
        );
      }

      await this.taskRepo.update(task.id, {
        status: 'PLAN_READY',
        plan,
        planSummary: plan.objectiveSummary,
        plannerModel: result.model,
        currentStepIndex: 0,
        error: null,
      });
      Object.assign(task, {
        status: 'PLAN_READY',
        plan,
        planSummary: plan.objectiveSummary,
        plannerModel: result.model,
        currentStepIndex: 0,
        error: null,
      });

      await this.createEvent(task.id, 'PLANNING_COMPLETED', {
        model: result.model,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        stepCount: plan.steps.length,
      });
      await this.createEvent(task.id, 'PLAN_READY', {
        objectiveSummary: plan.objectiveSummary,
        stepCount: plan.steps.length,
        // Rationale is untrusted explanatory text and is shown verbatim as
        // text in the UI, never interpreted as instructions.
        rationale: plan.rationale,
        approvalSteps: policyResult.approvalSteps,
      });

      return await this.engine.executePlan(task, plan);
    } catch (error) {
      if (error instanceof PlanningError) {
        return await this.handlePlanningFailure(task.id, error);
      }
      if (error instanceof ServiceError) {
        throw error;
      }
      if (task.status === 'CANCELLED') {
        // A cancellation that landed while a recovery or vision step was in
        // flight must not be overwritten with a failure reason.
        return { status: 'cancelled', error: task.error ?? 'Cancelled by user', executedActions: 0 };
      }
      await this.taskRepo.update(task.id, {
        status: 'FAILED',
        error: 'Planning or execution failed safely',
      });
      await this.createEvent(task.id, 'ERROR', {
        code: 'INTERNAL_ERROR',
        message: 'Planning or execution failed safely',
      });
      return { status: 'failed', error: 'Planning or execution failed safely', executedActions: 0 };
    } finally {
      this.active.delete(task.id);
      this.aborts.delete(task.id);
    }
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new ServiceError('NOT_FOUND', 'Task not found', 404);
    if (isTerminalStatus(task.status)) return task;

    this.aborts.get(taskId)?.abort('cancelled');
    this.planner.cancel?.(taskId);
    await this.engine.discardPausedSession?.(taskId);

    await this.taskRepo.update(taskId, {
      status: 'CANCELLED',
      error: 'Cancelled by user',
    });
    task.status = 'CANCELLED';
    task.error = 'Cancelled by user';
    await this.createEvent(taskId, 'TASK_CANCELLED', { message: 'Cancelled by user' });
    return task;
  }

  async approve(taskId: string, approvalId?: string): Promise<Task> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new ServiceError('NOT_FOUND', 'Task not found', 404);
    if (task.status !== 'AWAITING_APPROVAL') {
      throw new ServiceError('NOT_AWAITING_APPROVAL', 'Task is not awaiting approval', 409);
    }
    if (!task.plan) {
      throw new ServiceError('INVALID_PLAN', 'Task has no persisted plan', 409);
    }
    // The engine persists AWAITING_APPROVAL just before it finishes closing the
    // browser. Wait briefly for that cleanup so approval does not race it.
    await this.waitForIdle(taskId, 5_000);
    if (this.active.has(taskId)) {
      throw new ServiceError('DUPLICATE_EXECUTION', 'Task is already running', 409);
    }

    const pending = approvalId
      ? await this.approvalRepo.getById(approvalId)
      : await this.approvalRepo.getPending(taskId);
    if (!pending || pending.taskId !== taskId) {
      throw new ServiceError('APPROVAL_NOT_FOUND', 'No pending approval for this task', 404);
    }
    if (pending.status !== 'PENDING') {
      throw new ServiceError('APPROVAL_ALREADY_DECIDED', 'Approval was already decided', 409);
    }

    const step = task.plan.steps[pending.stepIndex];
    if (!step || !actionsEqual(step.action, pending.action)) {
      await this.approvalRepo.decide(pending.id, 'REJECTED');
      await this.engine.discardPausedSession?.(taskId);
      await this.failTask(taskId, 'Approval no longer matches the persisted plan', 'APPROVAL_MISMATCH');
      throw new ServiceError('APPROVAL_MISMATCH', 'Approval does not match the plan', 409);
    }

    // Revalidate schema and policy after approval. Approval cannot broaden
    // the action schema or the configured origin.
    const decision = this.policy.evaluate(step.action);
    if (!decision.allowed) {
      await this.approvalRepo.decide(pending.id, 'REJECTED');
      await this.engine.discardPausedSession?.(taskId);
      await this.createEvent(taskId, 'POLICY_REJECTION', {
        stepIndex: pending.stepIndex,
        actionType: step.action.type,
        code: decision.code,
        message: decision.reason,
      });
      await this.failTask(taskId, decision.reason ?? 'Policy rejected approved action', 'POLICY_REJECTION');
      throw new ServiceError('POLICY_REJECTION', decision.reason ?? 'Policy rejected the action', 409);
    }

    const decided = await this.approvalRepo.decide(pending.id, 'APPROVED');
    if (!decided) {
      throw new ServiceError('APPROVAL_ALREADY_DECIDED', 'Approval was already decided', 409);
    }

    await this.createEvent(taskId, 'APPROVAL_GRANTED', {
      approvalId: pending.id,
      stepIndex: pending.stepIndex,
      actionType: step.action.type,
    });

    this.active.add(taskId);
    try {
      await this.engine.executePlan(task, task.plan, {
        startIndex: pending.stepIndex,
        approval: { approvalId: pending.id, stepIndex: pending.stepIndex },
      });
    } finally {
      this.active.delete(taskId);
    }

    return (await this.taskRepo.getById(taskId)) ?? task;
  }

  async reject(taskId: string, approvalId?: string): Promise<Task> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new ServiceError('NOT_FOUND', 'Task not found', 404);
    if (task.status !== 'AWAITING_APPROVAL') {
      throw new ServiceError('NOT_AWAITING_APPROVAL', 'Task is not awaiting approval', 409);
    }

    const pending = approvalId
      ? await this.approvalRepo.getById(approvalId)
      : await this.approvalRepo.getPending(taskId);
    if (!pending || pending.taskId !== taskId) {
      throw new ServiceError('APPROVAL_NOT_FOUND', 'No pending approval for this task', 404);
    }

    const decided = await this.approvalRepo.decide(pending.id, 'REJECTED');
    if (!decided) {
      throw new ServiceError('APPROVAL_ALREADY_DECIDED', 'Approval was already decided', 409);
    }

    await this.engine.discardPausedSession?.(taskId);
    await this.createEvent(taskId, 'APPROVAL_REJECTED', {
      approvalId: pending.id,
      stepIndex: pending.stepIndex,
      actionType: pending.action.type,
    });
    await this.taskRepo.update(taskId, {
      status: 'CANCELLED',
      error: 'The proposed action was rejected by the user',
    });
    task.status = 'CANCELLED';
    task.error = 'The proposed action was rejected by the user';
    await this.createEvent(taskId, 'TASK_CANCELLED', {
      message: 'Plan stopped after approval rejection',
    });
    return task;
  }

  async listTasks(limit = 50): Promise<Task[]> {
    return this.taskRepo.list(limit);
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.taskRepo.getById(taskId);
  }

  async getPendingApproval(taskId: string): Promise<ApprovalRequestRecord | null> {
    return this.approvalRepo.getPending(taskId);
  }

  async getEvents(taskId: string): Promise<TaskEvent[]> {
    return this.taskRepo.getEvents(taskId);
  }

  private async waitForIdle(taskId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (this.active.has(taskId) && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async safeObservations(): Promise<string[]> {    if (!this.observationProvider) return [];
    try {
      const observations = await this.observationProvider();
      return observations.slice(0, 6).map((item) => item.slice(0, 1_500));
    } catch {
      return [];
    }
  }

  private async handlePlanningFailure(
    taskId: string,
    error: PlanningError
  ): Promise<ExecutionOutcome> {
    const current = await this.taskRepo.getById(taskId);
    if (!current || current.status === 'CANCELLED') {
      return { status: 'cancelled', executedActions: 0 };
    }

    const isModelFailure = [
      'MODEL_UNAVAILABLE',
      'MODEL_TIMEOUT',
      'MODEL_CANCELLED',
      'GENERATION_FAILED',
      'MALFORMED_OUTPUT',
    ].includes(error.code);

    const eventType: TaskEventType = isModelFailure
      ? 'MODEL_ERROR'
      : 'PLAN_VALIDATION_FAILED';
    const safeMessage = `${error.message} (${error.code})`.slice(0, 500);
    const issues = error.issues.slice(0, 6).map((item) => item.slice(0, 240));

    await this.taskRepo.update(taskId, {
      status: 'FAILED',
      error: safeMessage,
    });
    await this.createEvent(taskId, eventType, {
      code: error.code,
      message: safeMessage,
      issues,
      attempts: error.attempts,
    });

    return { status: 'failed', error: safeMessage, executedActions: 0 };
  }

  private async failTask(taskId: string, message: string, code: string): Promise<void> {
    await this.taskRepo.update(taskId, { status: 'FAILED', error: message });
    await this.createEvent(taskId, 'ERROR', { code, message });
  }

  private async createEvent(
    taskId: string,
    type: TaskEventType,
    data: Record<string, unknown> = {}
  ): Promise<void> {
    await this.taskRepo.addEvent({
      id: crypto.randomUUID(),
      taskId,
      type,
      timestamp: Date.now(),
      data,
    });
  }
}
