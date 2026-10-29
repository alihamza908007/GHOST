import {
  Action,
  ActionPolicy,
  ActionSchema,
  ExecutionOutcome,
  LIMITS,
  Plan,
  PlanStep,
  Task,
  TaskEvent,
  TaskEventType,
  VerificationResult,
  actionsEqual,
  isTerminalStatus,
} from '@ghost/core';
import { IApprovalRepository, IEvidenceRepository, ITaskRepository } from '@ghost/storage';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  BudgetError,
  CancelledError,
  DuplicateExecutionError,
  PolicyViolationError,
  VerificationError,
} from './errors.js';
import { BrowserToolRegistry, BrowserToolResult } from './tools.js';
import {
  evaluateExpectation,
  VerificationContext,
  verifyAction,
} from './verification.js';

export interface IExecutionEngine {
  executePlan(
    task: Task,
    plan: Plan | PlanStep[] | Action[],
    options?: ExecutePlanOptions
  ): Promise<ExecutionOutcome>;
  discardPausedSession?(taskId: string): Promise<void>;
}

export interface ExecutePlanOptions {
  startIndex?: number;
  approval?: {
    approvalId: string;
    stepIndex: number;
  };
}

export interface ExecutionEngineOptions {
  policy?: ActionPolicy;
  approvalRepo?: IApprovalRepository;
  maxActions?: number;
  actionTimeoutMs?: number;
  taskTimeoutMs?: number;
  tools?: BrowserToolRegistry;
}

interface VerificationSummary {
  allPassed: boolean;
  results: VerificationResult[];
}

interface PausedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  startedAt: number;
  executedActions: number;
  state: BrowserSessionState;
}

interface BrowserSessionState {
  blockedRequest: string | null;
  popupViolation: boolean;
  securityViolation: string | null;
}

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export class ExecutionEngine implements IExecutionEngine {
  private readonly tools: BrowserToolRegistry;
  private readonly active = new Set<string>();
  private readonly pausedSessions = new Map<string, PausedSession>();

  constructor(
    private taskRepo: ITaskRepository,
    private evidenceRepo: IEvidenceRepository,
    private allowedOrigin: string,
    private evidenceDir: string,
    private options: ExecutionEngineOptions = {}
  ) {
    this.tools = options.tools ?? new BrowserToolRegistry();
  }

  private get policy(): ActionPolicy {
    return this.options.policy ?? new ActionPolicy({ allowedOrigin: this.allowedOrigin });
  }

  private get maxActions(): number {
    return this.options.maxActions ?? LIMITS.MAX_EXECUTED_ACTIONS;
  }

  private async createEvent(
    taskId: string,
    type: TaskEventType,
    data: Record<string, unknown> = {}
  ): Promise<void> {
    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      timestamp: Date.now(),
      data,
    };
    await this.taskRepo.addEvent(event);
  }

  async executePlan(
    task: Task,
    rawPlan: Plan | PlanStep[] | Action[],
    options: ExecutePlanOptions = {}
  ): Promise<ExecutionOutcome> {
    if (this.active.has(task.id)) {
      throw new DuplicateExecutionError(task.id);
    }
    this.active.add(task.id);

    const steps = normalizePlan(rawPlan);
    const startIndex = options.startIndex ?? 0;
    let executedActions = startIndex;

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let keepSession = false;
    let startedAt = Date.now();
    const state: BrowserSessionState = {
      blockedRequest: null,
      popupViolation: false,
      securityViolation: null,
    };

    // Browser-level violations are recorded once, at detection time, so the
    // audit trail contains a POLICY_REJECTION even when Playwright surfaces the
    // failure as a navigation error instead of a policy error.
    let violationEvent: Promise<void> | null = null;
    const reportBrowserViolation = (message: string): void => {
      state.securityViolation = state.securityViolation ?? message;
      violationEvent ??= this.createEvent(task.id, 'POLICY_REJECTION', {
        phase: 'browser',
        code: 'UNAPPROVED_ORIGIN',
        message,
      }).catch(() => undefined);
    };

    try {
      if (isTerminalStatus(task.status) && task.status !== 'VERIFYING') {
        return { status: 'failed', error: 'Task is already in a terminal state', executedActions };
      }

      // Pre-flight: validate the whole plan before launching a browser. Each
      // action is still re-validated and re-authorized immediately before use.
      const planPolicy = this.policy.validatePlan(
        {
          objectiveSummary: task.planSummary ?? task.objective.slice(0, 200),
          steps,
        },
        { objective: task.objective }
      );
      if (!planPolicy.allowed) {
        const message = planPolicy.violations.map((item) => item.message).join('; ');
        await this.createEvent(task.id, 'POLICY_REJECTION', {
          phase: 'preflight',
          violations: planPolicy.violations.map((item) => ({
            stepIndex: item.stepIndex,
            code: item.code,
            message: item.message,
          })),
        });
        throw new PolicyViolationError(
          planPolicy.violations[0]?.code ?? 'INVALID_ACTION',
          message || 'Plan rejected by policy'
        );
      }

      if (startIndex > 0 && task.status !== 'AWAITING_APPROVAL') {
        throw new PolicyViolationError(
          'INVALID_ACTION',
          'A plan can only resume from a task awaiting approval'
        );
      }

      await this.taskRepo.update(task.id, {
        status: 'EXECUTING',
        error: null,
      });
      task.status = 'EXECUTING';

      const paused = startIndex > 0 ? this.pausedSessions.get(task.id) : undefined;
      if (startIndex > 0 && !paused) {
        throw new PolicyViolationError(
          'PAUSED_SESSION_UNAVAILABLE',
          'The paused browser session is no longer available; retry the task from the beginning'
        );
      }

      if (paused) {
        browser = paused.browser;
        context = paused.context;
        page = paused.page;
        startedAt = Date.now();
        executedActions = paused.executedActions;
        Object.assign(state, paused.state);
        this.pausedSessions.delete(task.id);
      } else {
        const launchOptions: { headless: boolean; channel?: string } = { headless: true };
        if (process.env.PLAYWRIGHT_CHROMIUM_CHANNEL) {
          launchOptions.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
        } else if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
          launchOptions.channel = 'chrome';
        }

        browser = await chromium.launch(launchOptions);
        context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          serviceWorkers: 'block',
          acceptDownloads: false,
        });

        const isAllowedRequestUrl = (rawUrl: string): boolean => {
          if (
            rawUrl.startsWith('about:') ||
            rawUrl.startsWith('data:') ||
            rawUrl.startsWith('blob:')
          ) {
            return true;
          }
          try {
            return new URL(rawUrl).origin === this.allowedOrigin;
          } catch {
            return false;
          }
        };

        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (!isAllowedRequestUrl(url)) {
            state.blockedRequest = url;
            reportBrowserViolation(
              'A browser request outside the approved origin was blocked'
            );
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });

        page = await context.newPage();

        context.on('page', (newPage) => {
          if (newPage !== page) {
            state.popupViolation = true;
            reportBrowserViolation('A popup was opened and rejected by policy');
            void newPage.close().catch(() => undefined);
          }
        });
        page.on('dialog', (dialog) => {
          void dialog.dismiss().catch(() => undefined);
        });
      }

      const activePage = page;
      if (!activePage) {
        throw new PolicyViolationError('PAUSED_SESSION_UNAVAILABLE', 'Browser page is unavailable');
      }

      const actionTimeoutMs = this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
      const taskTimeoutMs = this.options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

      for (let index = startIndex; index < steps.length; index += 1) {
        const step = steps[index]!;

        // 1. Task status / cancellation check against persisted state.
        const current = await this.taskRepo.getById(task.id);
        if (current?.status === 'CANCELLED') {
          throw new CancelledError();
        }
        if (state.popupViolation || state.blockedRequest) {
          throw new PolicyViolationError(
            'UNAPPROVED_ORIGIN',
            'A popup or request outside the approved origin was rejected'
          );
        }

        // 2. Budget and timeout checks.
        if (executedActions >= this.maxActions) {
          throw new BudgetError(`Action budget of ${this.maxActions} was exhausted`);
        }
        if (Date.now() - startedAt > taskTimeoutMs) {
          throw new BudgetError('Task execution timeout was exceeded');
        }

        // 3. Schema validation immediately before policy.
        const parsedAction = ActionSchema.safeParse(step.action);
        if (!parsedAction.success) {
          throw new PolicyViolationError(
            'INVALID_ACTION',
            'Action failed schema validation before execution'
          );
        }
        const action = parsedAction.data;

        // 4. Policy authorization.
        const decision = this.policy.evaluate(action);
        if (!decision.allowed) {
          await this.createEvent(task.id, 'POLICY_REJECTION', {
            stepIndex: index,
            actionType: action.type,
            code: decision.code,
            message: decision.reason,
          });
          throw new PolicyViolationError(
            decision.code ?? 'INVALID_ACTION',
            decision.reason ?? 'Action rejected by policy'
          );
        }

        // 5. Human approval boundary for high-consequence actions.
        if (decision.requiresApproval) {
          const approved = await this.isApproved(task.id, action, index, options);
          if (!approved) {
            if (!this.options.approvalRepo) {
              await this.createEvent(task.id, 'POLICY_REJECTION', {
                stepIndex: index,
                actionType: action.type,
                code: 'APPROVAL_UNAVAILABLE',
                message: 'Action requires approval but no approval store is configured',
              });
              throw new PolicyViolationError(
                'HIGH_CONSEQUENCE_ACTION',
                'Action requires approval but no approval store is configured'
              );
            }

            const pending = await this.options.approvalRepo.createPending({
              taskId: task.id,
              stepIndex: index,
              action,
              reason: decision.reason ?? 'High-consequence action requires approval',
            });
            await this.taskRepo.update(task.id, {
              status: 'AWAITING_APPROVAL',
              currentStepIndex: index,
              error: null,
            });
            task.status = 'AWAITING_APPROVAL';
            task.currentStepIndex = index;
            await this.createEvent(task.id, 'APPROVAL_REQUIRED', {
              approvalId: pending.id,
              stepIndex: index,
              actionType: action.type,
              description: step.description,
              reason: decision.reason,
            });
            if (browser && context && activePage) {
              this.pausedSessions.set(task.id, {
                browser,
                context,
                page: activePage,
                startedAt,
                executedActions,
                state,
              });
              keepSession = true;
            }
            return { status: 'awaiting_approval', executedActions };
          }
        }

        // 6. Capture pre-action state, then execute only through a registered
        // typed tool. A click expectation that already held before the click
        // cannot be used as proof afterwards.
        const baseVerificationContext: VerificationContext = {
          allowedOrigin: this.allowedOrigin,
          taskId: task.id,
          evidenceDir: this.evidenceDir,
          fileExists: (filename) => this.evidenceRepo.exists(filename),
          fileSize: (filename) => this.evidenceRepo.size(filename),
        };

        let preexistingCondition = false;
        if (action.type === 'CLICK') {
          try {
            const pre = await evaluateExpectation(activePage, step.expectation, {
              ...baseVerificationContext,
              timeoutMs: Math.min(750, actionTimeoutMs),
            });
            preexistingCondition = pre?.outcome === 'passed';
          } catch {
            preexistingCondition = false;
          }
        }

        await this.createEvent(task.id, 'ACTION_STARTED', {
          stepIndex: index,
          actionType: action.type,
          description: step.description,
        });

        let toolResult: BrowserToolResult = {};
        try {
          toolResult = await this.tools.execute(action, {
            page: activePage,
            taskId: task.id,
            evidenceDir: this.evidenceDir,
            actionTimeoutMs,
          });
        } finally {
          if (state.popupViolation) {
            throw new PolicyViolationError(
              'UNAPPROVED_ORIGIN',
              'A popup was opened and rejected by policy'
            );
          }
          if (state.blockedRequest) {
            throw new PolicyViolationError(
              'UNAPPROVED_ORIGIN',
              'A browser request outside the approved origin was blocked'
            );
          }
        }

        executedActions += 1;
        await this.createEvent(task.id, 'ACTION_FINISHED', {
          stepIndex: index,
          actionType: action.type,
          ...(toolResult.evidenceFilename
            ? { screenshot: toolResult.evidenceFilename }
            : {}),
        });

        if (toolResult.evidenceFilename) {
          await this.evidenceRepo.save({
            taskId: task.id,
            filename: toolResult.evidenceFilename,
            type: 'screenshot',
            timestamp: Date.now(),
            size: toolResult.evidenceSize,
          });
        }

        // 7. Independent deterministic verification.
        const verification = await verifyAction(
          activePage,
          action,
          step.expectation,
          {
            ...baseVerificationContext,
            evidenceFilename: toolResult.evidenceFilename,
            preexistingCondition,
          }
        );

        await this.createEvent(task.id, 'VERIFICATION_RESULT', {
          stepIndex: index,
          actionType: action.type,
          outcome: verification.outcome,
          method: verification.method,
          detail: verification.detail,
          expectationKind: verification.expectationKind,
          evidenceRef: verification.evidenceRef,
        });

        if (verification.outcome !== 'passed') {
          throw new VerificationError(
            verification.detail,
            verification.outcome
          );
        }

        // 8. Persist progress.
        await this.taskRepo.update(task.id, { currentStepIndex: index + 1 });
        task.currentStepIndex = index + 1;
      }

      await this.taskRepo.update(task.id, { status: 'VERIFYING' });
      task.status = 'VERIFYING';
      await this.taskRepo.update(task.id, {
        status: 'COMPLETED',
        currentStepIndex: steps.length,
        error: null,
      });
      task.status = 'COMPLETED';
      task.currentStepIndex = steps.length;
      await this.createEvent(task.id, 'TASK_COMPLETED', {
        executedActions,
        steps: steps.length,
      });

      return { status: 'completed', executedActions };
    } catch (error) {
      if (error instanceof CancelledError) {
        return await this.handleFailure(task, error, executedActions);
      }

      if (violationEvent) {
        await violationEvent;
      }

      if (state.securityViolation) {
        const policyError =
          error instanceof PolicyViolationError && error.code === 'UNAPPROVED_ORIGIN'
            ? error
            : new PolicyViolationError('UNAPPROVED_ORIGIN', state.securityViolation);
        return await this.handleFailure(task, policyError, executedActions);
      }

      return await this.handleFailure(task, error, executedActions);
    } finally {
      if (!keepSession) {
        this.pausedSessions.delete(task.id);
        if (context) await context.close().catch(() => undefined);
        if (browser) await browser.close().catch(() => undefined);
      }
      this.active.delete(task.id);
    }
  }

  async discardPausedSession(taskId: string): Promise<void> {
    const session = this.pausedSessions.get(taskId);
    if (!session) return;
    this.pausedSessions.delete(taskId);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }

  private async isApproved(
    taskId: string,
    action: Action,
    stepIndex: number,
    options: ExecutePlanOptions
  ): Promise<boolean> {
    if (!options.approval || options.approval.stepIndex !== stepIndex) return false;
    if (!this.options.approvalRepo) return false;

    const record = await this.options.approvalRepo.getById(options.approval.approvalId);
    if (!record) return false;
    if (record.status !== 'APPROVED' || record.taskId !== taskId) return false;
    if (record.stepIndex !== stepIndex) return false;
    if (!actionsEqual(record.action, action)) return false;

    // Re-authorize the exact action after approval. Approval never broadens
    // the origin or action schema.
    const revalidated = this.policy.evaluate(action);
    return revalidated.allowed;
  }

  private async handleFailure(
    task: Task,
    error: unknown,
    executedActions: number
  ): Promise<ExecutionOutcome> {
    if (error instanceof CancelledError) {
      await this.taskRepo.update(task.id, {
        status: 'CANCELLED',
        error: 'Task was cancelled',
      });
      task.status = 'CANCELLED';
      await this.createEvent(task.id, 'TASK_CANCELLED', { message: 'Task was cancelled' });
      return { status: 'cancelled', error: error.message, executedActions };
    }

    const safeMessage =
      error instanceof PolicyViolationError ||
      error instanceof VerificationError ||
      error instanceof BudgetError
        ? error.message
        : 'Execution failed safely';

    await this.taskRepo.update(task.id, { status: 'FAILED', error: safeMessage });
    task.status = 'FAILED';
    task.error = safeMessage;
    await this.createEvent(task.id, 'ERROR', {
      message: safeMessage,
      code:
        error instanceof PolicyViolationError
          ? error.code
          : error instanceof VerificationError
            ? `VERIFICATION_${error.outcome.toUpperCase()}`
            : error instanceof BudgetError
              ? 'BUDGET_EXCEEDED'
              : 'EXECUTION_ERROR',
    });
    return { status: 'failed', error: safeMessage, executedActions };
  }
}

function legacyExpectation(action: Action): PlanStep['expectation'] {
  switch (action.type) {
    case 'NAVIGATE':
      return { kind: 'url', value: action.payload.url };
    case 'FILL':
      return { kind: 'fieldValue', locator: action.payload.locator };
    case 'SCREENSHOT':
      return { kind: 'screenshot' };
    case 'CLICK':
      return { kind: 'elementVisible', locator: action.payload.locator };
    default:
      return { kind: 'screenshot' };
  }
}

/** Preserve Phase 1 Action[] plans while accepting Phase 2 PlanStep[]. */
export function normalizePlan(plan: Plan | PlanStep[] | Action[]): PlanStep[] {
  if (!Array.isArray(plan)) {
    return plan.steps;
  }
  return plan.map((item, index) => {
    if ('action' in item && 'expectation' in item) {
      return item;
    }
    const action = item as Action;
    const description =
      action.type === 'NAVIGATE'
        ? `Navigate to ${action.payload.url}`
        : action.type === 'SCREENSHOT'
          ? `Capture screenshot ${action.payload.name}`
          : action.type === 'FILL'
            ? `Fill a form field (value redacted)`
            : `Click an element`;
    return {
      action,
      description,
      expectation: legacyExpectation(action),
    };
  });
}
