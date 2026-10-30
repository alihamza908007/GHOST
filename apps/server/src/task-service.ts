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
  normalizeOrigins,
  normalizeOrigin,
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
  approvedOrigins?: string[];
  skillRunRepo?: { create: (r: any) => Promise<void>; complete: (id: string, status: string, error?: string) => Promise<void>; list: (skillId?: string) => Promise<any[]> };
  observationProvider?: () => Promise<string[]>;
}

export class TaskService {
  private readonly taskRepo: ITaskRepository;
  private readonly approvalRepo: IApprovalRepository;
  private readonly planner: PlannerLike;
  private readonly engine: EngineLike;
  private readonly policy: ActionPolicy;
  private readonly plannerModel: string;
  private readonly approvedOrigins?: string[];
  private readonly skillRunRepo?: { create: (r: any) => Promise<void>; complete: (id: string, status: string, error?: string) => Promise<void>; list: (skillId?: string) => Promise<any[]> };
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
    this.approvedOrigins = options.approvedOrigins ?? this.policy.allowedOrigins;
    this.skillRunRepo = options.skillRunRepo;
    this.observationProvider = options.observationProvider;
  }

  async startTask(objective: string, approvedOrigins?: string[]): Promise<Task> {
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

    const requested = approvedOrigins && approvedOrigins.length > 0 ? approvedOrigins : (this.approvedOrigins ?? this.policy.allowedOrigins);
    // Strict: every supplied origin must normalize successfully; no silent dropping.
    for (const o of requested) {
      if (normalizeOrigin(o) === null) {
        throw new ServiceError('INVALID_ORIGIN', `Invalid approved origin: ${o}`, 400);
      }
    }
    const normalizedOrigins = normalizeOrigins(requested);
    if (normalizedOrigins.length === 0) {
      throw new ServiceError('INVALID_ORIGIN', 'At least one valid approved origin is required', 400);
    }

    const task: Task = {
      id: crypto.randomUUID(),
      objective: cleaned,
      status: 'PLANNING',
      approvedOrigins: normalizedOrigins,
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

  async runSkill(skill: { id: string; version: number; definition: any }, inputs: Record<string, unknown>, approvedOrigins?: string[]): Promise<Task> {
    const cleanedInputs = inputs ?? {};
    const skillDef = skill.definition;
    const inputSpecs: Array<{ name: string; type?: string; required?: boolean; maxLength?: number }> = skillDef.inputs ?? [];
    // Validate required/missing
    for (const spec of inputSpecs) {
      if (spec.required !== false) {
        const v = cleanedInputs[spec.name];
        if (v === undefined || v === null || v === '') {
          throw new ServiceError('INVALID_INPUT', `Missing required input: ${spec.name}`, 400);
        }
      }
    }
    // Validate types and lengths
    for (const spec of inputSpecs) {
      const v = cleanedInputs[spec.name];
      if (v === undefined || v === null) continue;
      if (spec.type === 'number' && typeof v !== 'number') {
        throw new ServiceError('INVALID_INPUT', `Input ${spec.name} must be a number`, 400);
      }
      if (spec.type === 'string' && typeof v !== 'string') {
        throw new ServiceError('INVALID_INPUT', `Input ${spec.name} must be a string`, 400);
      }
      if (typeof v === 'string' && v.length > (spec.maxLength ?? 500)) {
        throw new ServiceError('INVALID_INPUT', `Input ${spec.name} exceeds max length`, 400);
      }
    }
    // Reject unknown inputs
    const allowedNames = new Set(inputSpecs.map((s: any) => s.name));
    for (const k of Object.keys(cleanedInputs)) {
      if (!allowedNames.has(k)) {
        throw new ServiceError('INVALID_INPUT', `Unknown input: ${k}`, 400);
      }
    }

    // Redact sensitive inputs for storage
    const redactedInputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cleanedInputs)) {
      if (/password|secret|token|apikey/i.test(k)) {
        redactedInputs[k] = '[redacted]';
      } else {
        redactedInputs[k] = v;
      }
    }

    const origins = approvedOrigins && approvedOrigins.length > 0
      ? approvedOrigins
      : (this.approvedOrigins ?? this.policy.allowedOrigins);
    const normalizedOrigins = normalizeOrigins(origins);
    if (normalizedOrigins.length === 0) {
      throw new ServiceError('INVALID_ORIGIN', 'At least one approved origin is required', 400);
    }

    const task: Task = {
      id: crypto.randomUUID(),
      objective: `Skill: ${skillDef.name ?? skill.id}`,
      status: 'PLANNING',
      currentStepIndex: 0,
      lastEventId: null,
      plan: null,
      planSummary: skillDef.description ?? skillDef.name ?? skill.id,
      plannerModel: 'skill',
      approvedOrigins: normalizedOrigins,
      error: null,
    };
    await this.taskRepo.create(task);

    const runId = crypto.randomUUID();
    const skillRunRepo = (this as any).skillRunRepo;
    if (skillRunRepo) {
      await skillRunRepo.create({ id: runId, skillId: skill.id, skillVersion: skill.version, taskId: task.id, inputs: redactedInputs });
    }

    // Fire and forget
    void (async () => {
      try {
        await this.taskRepo.update(task.id, { status: 'PLAN_READY', plan: { objectiveSummary: task.objective, steps: skillDef.steps ?? [], rationale: 'skill' }, planSummary: task.planSummary, currentStepIndex: 0, error: null });
        Object.assign(task, { status: 'PLAN_READY', plan: { objectiveSummary: task.objective, steps: skillDef.steps ?? [], rationale: 'skill' }, currentStepIndex: 0, error: null });
        // Substitute placeholders {{name}} in action payloads (string values only).
        const substitute = (obj: any): any => {
          if (typeof obj === 'string') {
            return obj.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name) => {
              const v = cleanedInputs[name];
              return v === undefined || v === null ? '' : String(v);
            });
          }
          if (Array.isArray(obj)) return obj.map(substitute);
          if (obj && typeof obj === 'object') {
            const out: any = {};
            for (const [k, v] of Object.entries(obj)) out[k] = substitute(v);
            return out;
          }
          return obj;
        };
        const substitutedSteps = (skillDef.steps ?? []).map((s: any) => ({
          ...s,
          action: substitute(s.action),
          description: substitute(s.description),
        }));
        const plan = { objectiveSummary: task.objective, steps: substitutedSteps, rationale: 'skill' };
        task.plan = plan as any;
        await this.taskRepo.update(task.id, { plan });
        const outcome = await this.engine.executePlan(task, plan);
        if (skillRunRepo) {
          await skillRunRepo.complete(runId, outcome.status === 'completed' ? 'COMPLETED' : outcome.status.toUpperCase(), outcome.error ?? undefined);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Skill execution failed';
        await this.taskRepo.update(task.id, { status: 'FAILED', error: msg });
        if (skillRunRepo) await skillRunRepo.complete(runId, 'FAILED', msg);
      }
    })().catch(() => undefined);

    return (await this.taskRepo.getById(task.id)) ?? task;
  }

  async startResearch(objective: string, approvedOrigins: string[], fields: Array<{ name: string; type: string; description?: string }>, pageBudget: number): Promise<Task> {
    const cleaned = objective.trim();
    if (cleaned.length === 0) throw new ServiceError('INVALID_OBJECTIVE', 'An objective is required');
    const normalizedOrigins = normalizeOrigins(approvedOrigins ?? []);
    if (normalizedOrigins.length === 0) throw new ServiceError('INVALID_ORIGIN', 'At least one approved origin is required', 400);

    const task: Task = {
      id: crypto.randomUUID(),
      objective: cleaned,
      status: 'PLANNING',
      currentStepIndex: 0,
      lastEventId: null,
      plan: null,
      planSummary: null,
      plannerModel: this.plannerModel,
      approvedOrigins: normalizedOrigins,
      researchFields: fields ?? [],
      researchBudget: pageBudget ?? 5,
      error: null,
    };
    await this.taskRepo.create(task);

    // Fire and forget
    void this.runResearch(task).catch(() => undefined);
    return (await this.taskRepo.getById(task.id)) ?? task;
  }

  async runResearch(task: Task): Promise<void> {
    if (this.active.has(task.id)) return;
    this.active.add(task.id);
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    try {
      const fresh = await this.taskRepo.getById(task.id);
      if (!fresh) return;

      const origins = fresh.approvedOrigins ?? [];
      const fields = fresh.researchFields ?? [];
      const budget = fresh.researchBudget ?? 5;
      const findings: Array<{ field: string; value: string; sourceUrl: string; status: string }> = [];
      const visited: string[] = [];

      await this.taskRepo.update(task.id, { status: 'EXECUTING', error: null });
      task.status = 'EXECUTING';

      let pagesVisited = 0;
      for (const origin of origins) {
        if (pagesVisited >= budget) break;
        if (abort.signal.aborted) break;
        const url = origin;
        visited.push(url);
        pagesVisited++;
        // Fetch page text (sanitized)
        let text = '';
        try {
          const res = await fetch(url, { signal: abort.signal });
          if (res.ok) {
            const html = await res.text();
            text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
          }
        } catch {
          text = '';
        }
        // Extract fields via simple pattern: "FieldName: value" or "FieldName = value"
        for (const f of fields) {
          const re = new RegExp(f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\s*([^.;\n]{1,200})', 'i');
          const m = text.match(re);
          const value = m ? m[1].trim() : null;
          findings.push({
            field: f.name,
            value: value ?? 'UNAVAILABLE',
            sourceUrl: url,
            status: value ? 'unverified' : 'unavailable',
          });
        }
        await this.createEvent(task.id, 'ACTION_FINISHED', { actionType: 'NAVIGATE', url, pagesVisited });
      }

      // Deduplicate: keep first occurrence per field
      const seen = new Set<string>();
      const deduped = findings.filter((f) => {
        if (seen.has(f.field + ':' + f.value)) return false;
        seen.add(f.field + ':' + f.value);
        return true;
      });

      const result = { visited, findings: deduped, completedAt: new Date().toISOString() };
      await this.taskRepo.update(task.id, { status: 'COMPLETED', researchResultJson: JSON.stringify(result), error: null });
      task.status = 'COMPLETED';
      await this.createEvent(task.id, 'TASK_COMPLETED', { research: true, findings: deduped.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Research failed';
      await this.taskRepo.update(task.id, { status: 'FAILED', error: msg });
      task.status = 'FAILED';
      await this.createEvent(task.id, 'ERROR', { code: 'RESEARCH_ERROR', message: msg });
    } finally {
      this.active.delete(task.id);
      this.aborts.delete(task.id);
    }
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

      // Authorization must already be persisted on the task. Never create or
      // widen it during execution. Missing/invalid authorization fails closed.
      const normalized = normalizeOrigins(fresh.approvedOrigins ?? []);
      if (normalized.length === 0) {
        await this.taskRepo.update(task.id, {
          status: 'FAILED',
          error: 'Task authorization snapshot is missing or invalid; reauthorization required.',
        });
        await this.createEvent(task.id, 'ERROR', {
          code: 'AUTHORIZATION_MISSING',
          message: 'Task authorization snapshot is missing or invalid; reauthorization required.',
        });
        return { status: 'failed', error: 'Task authorization snapshot is missing or invalid', executedActions: 0 };
      }
      fresh.approvedOrigins = normalized;

      const MAX_ITERATIONS = 3;
      const priorActions: Array<{ stepIndex: number; actionType: string; description?: string; outcome?: string }> = [];
      const verificationResults: Array<{ stepIndex: number; outcome: string; method: string }> = [];
      const seenPlans = new Set<string>();
      let finalOutcome: ExecutionOutcome | null = null;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const current = await this.taskRepo.getById(task.id);
        if (!current || current.status === 'CANCELLED' || isTerminalStatus(current.status)) {
          if (current?.status === 'CANCELLED') {
            return { status: 'cancelled', executedActions: 0 };
          }
          if (current && isTerminalStatus(current.status)) {
            // Already terminal (e.g., completed by a prior iteration).
            break;
          }
          break;
        }

        await this.createEvent(task.id, 'PLANNING_STARTED', {
          model: this.plannerModel,
          maxSteps: LIMITS.MAX_PLAN_STEPS,
          maxActions: LIMITS.MAX_EXECUTED_ACTIONS,
          maxAttempts: LIMITS.MAX_PLANNER_ATTEMPTS,
          iteration: iteration + 1,
        });

        const observations = await this.safeObservations();
        const result = await this.planner.plan(
          {
            objective: fresh.objective,
            observations,
            approvedOrigins: fresh.approvedOrigins ?? this.policy.allowedOrigins,
            priorActions,
            verificationResults,
          },
          { requestId: task.id, signal: abort.signal }
        );

        const afterPlanning = await this.taskRepo.getById(task.id);
        if (!afterPlanning || afterPlanning.status === 'CANCELLED') {
          return { status: 'cancelled', executedActions: 0 };
        }

        const plan = result.plan;
        // The task's approved origin set is authoritative for the first
        // navigation; the planner may not silently fall back to a different
        // origin it associates with the workflow.
        const taskApproved = normalizeOrigins(fresh.approvedOrigins ?? []);
        if (taskApproved.length > 0 && plan.steps[0]?.action?.type === 'NAVIGATE') {
          const forcedAction = { ...plan.steps[0].action, payload: { url: taskApproved[0] } };
          const forcedExpectation =
            plan.steps[0].expectation?.kind === 'url'
              ? { ...plan.steps[0].expectation, value: taskApproved[0] }
              : plan.steps[0].expectation;
          plan.steps[0] = {
            ...plan.steps[0],
            action: forcedAction,
            expectation: forcedExpectation,
          } as typeof plan.steps[0];
        }
        const policyResult = this.policy.validatePlan(plan, {
          objective: fresh.objective,
          origins: taskApproved.length > 0 ? taskApproved : this.policy.allowedOrigins,
        });
        if (!policyResult.allowed) {
          throw new PlanningError(
            'POLICY_VIOLATION',
            'The plan failed final policy validation',
            result.attempts,
            policyResult.violations.map((item) => item.message)
          );
        }

        // No-progress detection: identical plan repeated.
        if (plan.steps.length === 0) {
          // Planner signaled completion (or blocked). Verify against persisted evidence.
          const events = await this.taskRepo.getEvents(task.id);
          const lastVer = [...events].reverse().find((e) => e.type === 'VERIFICATION_RESULT');
          const lastOutcome = lastVer?.data?.outcome;
          if (lastOutcome === 'passed') {
            await this.taskRepo.update(task.id, { status: 'COMPLETED', currentStepIndex: (task.plan?.steps.length ?? 0), error: null });
            task.status = 'COMPLETED';
            await this.createEvent(task.id, 'TASK_COMPLETED', { adaptive: true });
            return { status: 'completed', executedActions: 0 };
          }
          await this.taskRepo.update(task.id, { status: 'FAILED', error: 'Planner reported completion but no verified success.' });
          await this.createEvent(task.id, 'ERROR', { code: 'UNVERIFIED_COMPLETION', message: 'Planner reported completion without verified success.' });
          return { status: 'failed', error: 'Unverified completion', executedActions: 0 };
        }

        const sig = JSON.stringify(plan.steps.map((s: any) => `${s.action?.type}:${s.action?.payload?.url ?? ''}`));
        if (seenPlans.has(sig) && plan.steps.length > 0) {
          await this.taskRepo.update(task.id, {
            status: 'FAILED',
            error: 'No progress detected (repeated plan); stopping safely.',
          });
          await this.createEvent(task.id, 'ERROR', {
            code: 'NO_PROGRESS',
            message: 'Repeated identical plan detected; stopping to avoid an infinite loop.',
          });
          return { status: 'failed', error: 'No progress detected', executedActions: 0 };
        }
        seenPlans.add(sig);

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
          iteration: iteration + 1,
        });
        await this.createEvent(task.id, 'PLAN_READY', {
          objectiveSummary: plan.objectiveSummary,
          stepCount: plan.steps.length,
          rationale: plan.rationale,
          approvalSteps: policyResult.approvalSteps,
        });

        const outcome = await this.engine.executePlan(task, plan);
        finalOutcome = outcome;

        if (outcome.status === 'completed') {
          return outcome;
        }
        if (outcome.status === 'cancelled') {
          return outcome;
        }
        if (outcome.status === 'awaiting_approval') {
          return outcome;
        }

        // Failed: record for next iteration's context.
        priorActions.push({ stepIndex: iteration, actionType: 'PLAN', outcome: outcome.status });
        verificationResults.push({ stepIndex: iteration, outcome: outcome.status, method: 'engine' });

        // Reset to PLANNING for next iteration.
        await this.taskRepo.update(task.id, { status: 'PLANNING', error: null });
        task.status = 'PLANNING';
      }

      // Exhausted iterations.
      await this.taskRepo.update(task.id, {
        status: 'FAILED',
        error: 'Maximum replanning iterations reached without verification success.',
      });
      await this.createEvent(task.id, 'ERROR', {
        code: 'MAX_ITERATIONS',
        message: 'Maximum replanning iterations reached.',
      });
      return finalOutcome ?? { status: 'failed', error: 'Maximum replanning iterations reached', executedActions: 0 };
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
    // the action schema or the task authorization snapshot.
    const taskForDecision = await this.taskRepo.getById(taskId);
    const approvedForDecision = taskForDecision
      ? normalizeOrigins(taskForDecision.approvedOrigins ?? [])
      : this.policy.allowedOrigins;
    const decision = approvedForDecision.length > 0 ? this.policy.evaluate(step.action, approvedForDecision) : this.policy.evaluate(step.action);
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
