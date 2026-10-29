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
  TaskStatus,
  VerificationResult,
  VisualEvaluation,
  VisualObserverLike,
  actionsEqual,
  isTerminalStatus,
  resolveContainedEvidencePath,
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

function isCancelled(status: TaskStatus): boolean {
  return status === 'CANCELLED';
}
import { evaluateRecovery } from './recovery.js';
import {
  combineVerification,
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
  /** Optional local visual perception collaborator. */
  visual?: VisualObserverLike;
  /** Visual inference timeout in milliseconds. */
  visionTimeoutMs?: number;
  /** Maximum recovery operations per task. */
  recoveryLimit?: number;
  /** Maximum retries of a single action within the recovery budget. */
  maxRetriesPerAction?: number;
  /** Allowlisted semantic close-control names for overlay dismissal. */
  recoveryCloseAllowlist?: string[];
  /** Whether screenshots are redacted for sensitive inputs before persistence. Defaults to true. */
  redactScreenshots?: boolean;
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
  private readonly lastVisual = new Map<string, VisualEvaluation>();
  private readonly lastVerification = new Map<string, VerificationResult>();
  private readonly recoveryCounts = new Map<string, number>();
  private readonly retryCounts = new Map<string, number>();

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

  private get recoveryLimit(): number {
    return this.options.recoveryLimit ?? LIMITS.MAX_RECOVERY_ATTEMPTS;
  }

  private get maxRetriesPerAction(): number {
    return this.options.maxRetriesPerAction ?? LIMITS.MAX_RECOVERY_RETRIES_PER_ACTION;
  }

  private get recoveryCloseAllowlist(): string[] {
    return this.options.recoveryCloseAllowlist ?? ['Close'];
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

        const isAllowedRequestUrl = (rawUrl: string, resourceType: string): boolean => {
          // Subresource schemes are permitted for non-document requests (e.g.
          // images/fonts), but a top-level document navigation to data:/blob:/
          // about: (other than about:blank) would escape the approved origin.
          const isDocument = resourceType === 'document';
          if (rawUrl === 'about:blank') return true;
          if (
            rawUrl.startsWith('about:') ||
            rawUrl.startsWith('data:') ||
            rawUrl.startsWith('blob:')
          ) {
            return !isDocument;
          }
          try {
            return new URL(rawUrl).origin === this.allowedOrigin;
          } catch {
            return false;
          }
        };

        await context.route('**/*', async (route) => {
          const url = route.request().url();
          const resourceType = route.request().resourceType();
          if (!isAllowedRequestUrl(url, resourceType)) {
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
        let actionExecutionFailed: VerificationResult | null = null;
        try {
          toolResult = await this.tools.execute(action, {
            page: activePage,
            taskId: task.id,
            evidenceDir: this.evidenceDir,
            actionTimeoutMs,
            redactScreenshots: this.options.redactScreenshots,
          });
        } catch (toolError) {
          if (
            toolError instanceof PolicyViolationError ||
            toolError instanceof CancelledError ||
            toolError instanceof BudgetError
          ) {
            throw toolError;
          }
          // An action that could not execute at all cannot satisfy its
          // postcondition; this becomes a deterministic failed verification so
          // the conservative recovery path can consider bounded options.
          actionExecutionFailed = {
            outcome: 'failed',
            method: 'action-execution',
            detail: 'The action could not be executed against the page',
            timestamp: Date.now(),
            taskId: task.id,
            stepIndex: index,
          };
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
        const verification: VerificationResult = actionExecutionFailed
          ? actionExecutionFailed
          : await verifyAction(
              activePage,
              action,
              step.expectation,
              {
                ...baseVerificationContext,
                evidenceFilename: toolResult.evidenceFilename,
                preexistingCondition,
              }
            );
        this.lastVerification.set(task.id, verification);

        // Optional visual diagnostic. Deterministic verification stays
        // authoritative; vision is consulted when the deterministic result is
        // not conclusive and never overrides a deterministic failure by itself.
        let visual: VisualEvaluation | undefined;
        if (
          this.options.visual &&
          action.type !== 'SCREENSHOT' &&
          verification.outcome !== 'passed'
        ) {
          visual = await this.runVisual(task.id, action, step, verification, {
            ...baseVerificationContext,
            evidenceFilename: toolResult.evidenceFilename,
          }, index);
          this.lastVisual.set(task.id, visual);
          await this.createEvent(task.id, visual.available ? 'VISUAL_OBSERVATION_COMPLETED' : 'VISUAL_UNAVAILABLE', {
            taskId: task.id,
            stepIndex: index,
            actionType: action.type,
            available: visual.available,
            ...(visual.observation
              ? {
                  expectedCondition: visual.observation.expectedCondition,
                  summary: visual.observation.summary,
                }
              : {}),
            ...(visual.error ? { reason: visual.error } : {}),
          });
          if (visual.available && visual.observation) {
            const disagreed =
              verification.outcome === 'failed' &&
              visual.observation.expectedCondition === 'present';
            if (!visual.agreed) {
              await this.createEvent(task.id, 'DOM_VISUAL_DISAGREEMENT', {
                taskId: task.id,
                stepIndex: index,
                actionType: action.type,
                deterministicOutcome: verification.outcome,
                visualSummary: visual.observation.summary,
                expectedCondition: visual.observation.expectedCondition,
              });
            }
          }
        }

        const finalVerification = this.options.visual
          ? combineVerification(verification, visual, task.id, index)
          : verification;

        await this.createEvent(task.id, 'VERIFICATION_RESULT', {
          stepIndex: index,
          actionType: action.type,
          outcome: finalVerification.outcome,
          method: finalVerification.method,
          detail: finalVerification.detail,
          expectationKind: finalVerification.expectationKind,
          evidenceRef: finalVerification.evidenceRef,
        });

        if (finalVerification.outcome !== 'passed') {
          const recovery = await this.runRecovery(task, steps, executedActions, activePage, state, index, finalVerification, startedAt);
          if (recovery.kind === 'completed') {
            return { status: 'completed', executedActions: recovery.executedActions };
          }
          if (recovery.kind === 'exhausted') {
            throw new VerificationError(finalVerification.detail, finalVerification.outcome);
          }
          // recovery.kind === 'continue' means a bounded recovery retry of this
          // step verified successfully; fall through to normal progress handling.
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

      if (error instanceof VerificationError) {
        // Recovery is orchestrated inside the plan loop; reaching the catch
        // means the bounded recovery sequence was exhausted or declined.
        return await this.handleFailure(task, error, executedActions);
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

  private async runRecovery(
    task: Task,
    steps: PlanStep[],
    executedActions: number,
    page: Page | null,
    state: BrowserSessionState,
    failedStepIndex: number,
    verification: VerificationResult,
    taskStartedAt: number
  ): Promise<{ kind: 'completed' | 'continue' | 'exhausted'; executedActions: number }> {
    const taskId = task.id;
    let taskStatus: TaskStatus = task.status;
    let currentVerification = verification;
    let currentVisual = this.lastVisual.get(taskId) ?? { available: false, error: 'VISUAL_UNAVAILABLE' };
    let attemptsUsed = this.recoveryCounts.get(taskId) ?? 0;

    // Honor a cancellation that landed before recovery started, even if the
    // in-memory task object has not been refreshed.
    const initial = await this.taskRepo.getById(taskId);
    if (initial?.status === 'CANCELLED' || initial?.status === 'FAILED' || initial?.status === 'COMPLETED') {
      return { kind: 'exhausted', executedActions };
    }

    const remainingRecoveryAttempts = Math.max(this.recoveryLimit - attemptsUsed, 0);
    for (let attempt = 0; attempt < remainingRecoveryAttempts; attempt += 1) {
      const refreshed = await this.taskRepo.getById(taskId);
      if (refreshed?.status === 'CANCELLED') {
        return { kind: 'exhausted', executedActions };
      }
      const decision = evaluateRecovery({
        task,
        verification: currentVerification,
        visual: currentVisual,
        policy: this.policy,
        allowedOrigin: this.allowedOrigin,
        recoveryCloseAllowlist: this.recoveryCloseAllowlist,
        recoveryAttemptsUsed: attemptsUsed,
        retriesForAction: this.retryCounts.get(taskId) ?? 0,
        failedStepIndex,
      });

      const rejectEventType =
        decision.code === 'RECOVERY_BUDGET_EXHAUSTED' ? 'RECOVERY_BUDGET_EXHAUSTED' : 'RETRY_REJECTED';
      if (!decision.allowed || !decision.action) {
        await this.createEvent(taskId, rejectEventType, {
          taskId,
          stepIndex: failedStepIndex,
          code: decision.code,
          reason: decision.reason,
        });
        return { kind: 'exhausted', executedActions };
      }

      if (isCancelled(taskStatus)) {
        return { kind: 'exhausted', executedActions };
      }
      if (executedActions >= this.maxActions) {
        throw new BudgetError(`Action budget of ${this.maxActions} was exhausted`);
      }
      if (Date.now() - taskStartedAt > (this.options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)) {
        throw new BudgetError('Task execution timeout was exceeded');
      }

      if (decision.action.kind === 'RETRY') {
        await this.createEvent(taskId, 'RETRY_AUTHORIZED', {
          taskId,
          stepIndex: failedStepIndex,
          recoveryAttempt: attemptsUsed,
          action: decision.action,
          reason: decision.reason ?? 'Retry authorized by evidence-driven recovery policy',
        });
      }

      attemptsUsed += 1;
      this.recoveryCounts.set(taskId, attemptsUsed);
      await this.taskRepo.update(taskId, { status: 'RETRYING', error: null });
      taskStatus = 'RETRYING';
      task.error = null;
      await this.createEvent(taskId, 'RECOVERY_STARTED', {
        taskId,
        stepIndex: failedStepIndex,
        recoveryAttempt: attemptsUsed,
        action: decision.action,
        reason: decision.reason,
      });

      const failedStep = steps[failedStepIndex];
      const actionSequence: Array<{ action: Action; expectation: PlanStep['expectation']; description: string }> = [];
      if (decision.action.kind === 'DISMISS_OVERLAY') {
        const locator = decision.action.locator;
        if (!locator) return { kind: 'exhausted', executedActions };
        actionSequence.push({
          action: { type: 'CLICK', payload: { locator } },
          expectation: failedStep?.expectation ?? { kind: 'elementVisible', locator },
          description: 'Dismiss obstructing overlay',
        });
        if (failedStep) {
          actionSequence.push({
            action: failedStep.action,
            expectation: failedStep.expectation,
            description: `Retry step ${failedStepIndex}`,
          });
        }
      } else {
        const retryStepIndex = decision.action.kind === 'RETRY' ? decision.action.stepIndex : failedStepIndex;
        const retryStep = steps[retryStepIndex];
        if (!retryStep) return { kind: 'exhausted', executedActions };
        actionSequence.push({
          action: retryStep.action,
          expectation: retryStep.expectation,
          description: `Retry step ${retryStepIndex}`,
        });
      }

      let sequenceIndex = 0;
      let lastExecutionFailed = false;
      while (sequenceIndex < actionSequence.length) {
        const current = actionSequence[sequenceIndex];
        if (!current) break;
        if (isCancelled(taskStatus)) {
          return { kind: 'exhausted', executedActions };
        }
        if (executedActions >= this.maxActions) {
          throw new BudgetError(`Action budget of ${this.maxActions} was exhausted`);
        }

        const refreshed = await this.taskRepo.getById(taskId);
        if (refreshed?.status === 'CANCELLED') {
          return { kind: 'exhausted', executedActions };
        }
        const auth = this.policy.evaluate(current.action);
        if (!auth.allowed) {
          await this.createEvent(taskId, 'RETRY_REJECTED', {
            taskId,
            stepIndex: failedStepIndex,
            code: auth.code ?? 'INVALID_ACTION',
            reason: auth.reason ?? 'Recovery action rejected by policy',
          });
          return { kind: 'exhausted', executedActions };
        }
        if (auth.requiresApproval) {
          await this.createEvent(taskId, 'RETRY_REJECTED', {
            taskId,
            stepIndex: failedStepIndex,
            code: 'APPROVAL_REQUIRED_FOR_RECOVERY',
            reason: auth.reason ?? 'Recovery action requires approval',
          });
          return { kind: 'exhausted', executedActions };
        }

        const context: VerificationContext = {
          allowedOrigin: this.allowedOrigin,
          taskId,
          evidenceDir: this.evidenceDir,
          fileExists: (filename) => this.evidenceRepo.exists(filename),
          fileSize: (filename) => this.evidenceRepo.size(filename),
          preexistingCondition: false,
        };

        await this.createEvent(taskId, 'ACTION_STARTED', {
          stepIndex: failedStepIndex,
          actionType: current.action.type,
          description: current.description,
        });

        let toolResult: BrowserToolResult = {};
        let elementFailed = false;
        if (!page) {
          return { kind: 'exhausted', executedActions };
        }
        try {
          toolResult = await this.tools.execute(current.action, {
            page,
            taskId,
            evidenceDir: this.evidenceDir,
            actionTimeoutMs: this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
            redactScreenshots: this.options.redactScreenshots,
          });
        } catch (toolError) {
          if (
            toolError instanceof PolicyViolationError ||
            toolError instanceof CancelledError ||
            toolError instanceof BudgetError
          ) {
            throw toolError;
          }
          elementFailed = true;
        } finally {
          if (state.popupViolation) {
            throw new PolicyViolationError('UNAPPROVED_ORIGIN', 'A popup was opened and rejected by policy');
          }
          if (state.blockedRequest) {
            throw new PolicyViolationError('UNAPPROVED_ORIGIN', 'A browser request outside the approved origin was blocked');
          }
        }

        executedActions += 1;
        await this.createEvent(taskId, 'ACTION_FINISHED', {
          stepIndex: failedStepIndex,
          actionType: current.action.type,
          ...(toolResult.evidenceFilename ? { screenshot: toolResult.evidenceFilename } : {}),
        });

        if (toolResult.evidenceFilename) {
          await this.evidenceRepo.save({
            taskId,
            filename: toolResult.evidenceFilename,
            type: 'screenshot',
            timestamp: Date.now(),
            size: toolResult.evidenceSize,
          });
        }

        taskStatus = 'VERIFYING';
        task.status = 'VERIFYING';
        await this.taskRepo.update(taskId, { status: 'VERIFYING', error: null });
        task.error = null;

        const verificationResult = elementFailed
          ? {
              outcome: 'failed' as const,
              method: 'action-execution',
              detail: 'The action could not be executed against the page',
              timestamp: Date.now(),
              taskId,
              stepIndex: failedStepIndex,
            }
          : await verifyAction(page, current.action, current.expectation, {
              ...context,
              evidenceFilename: toolResult.evidenceFilename,
            });
        currentVerification = verificationResult;
        this.lastVerification.set(taskId, verificationResult);
        await this.createEvent(taskId, 'VERIFICATION_RESULT', {
          stepIndex: failedStepIndex,
          actionType: current.action.type,
          outcome: verificationResult.outcome,
          method: verificationResult.method,
          detail: verificationResult.detail,
          expectationKind: verificationResult.expectationKind,
          evidenceRef: verificationResult.evidenceRef,
        });

        if (verificationResult.outcome === 'passed') {
          if (failedStepIndex + 1 >= steps.length) {
            taskStatus = 'COMPLETED';
            task.status = 'COMPLETED';
            task.currentStepIndex = steps.length;
            task.error = null;
            await this.taskRepo.update(taskId, {
              status: 'COMPLETED',
              currentStepIndex: steps.length,
              error: null,
            });
            await this.createEvent(taskId, 'TASK_COMPLETED', { executedActions, steps: steps.length, recovery: true });
            await this.createEvent(taskId, 'RECOVERY_COMPLETED', {
              taskId,
              stepIndex: failedStepIndex,
              recoveryAttempt: attemptsUsed,
              action: decision.action,
            });
            return { kind: 'completed', executedActions };
          }

          taskStatus = 'EXECUTING';
          task.status = 'EXECUTING';
          task.currentStepIndex = failedStepIndex + 1;
          task.error = null;
          await this.taskRepo.update(taskId, {
            status: 'EXECUTING',
            currentStepIndex: failedStepIndex + 1,
            error: null,
          });
          return { kind: 'continue', executedActions };
        }

        lastExecutionFailed = true;
        if (actionSequence.length > 1) {
          sequenceIndex += 1;
          continue;
        }
        break;
      }

      if (lastExecutionFailed) {
        continue;
      }
      break;
    }

    await this.createEvent(taskId, 'RECOVERY_BUDGET_EXHAUSTED', {
      taskId,
      stepIndex: failedStepIndex,
      attemptsUsed,
    });
    return { kind: 'exhausted', executedActions };
  }

  private async runVisual(
    taskId: string,
    action: Action,
    step: PlanStep,
    verification: VerificationResult,
    context: VerificationContext,
    stepIndex: number
  ): Promise<VisualEvaluation> {
    const visualObserver = this.options.visual;
    if (!visualObserver) {
      return { available: false, error: 'VISUAL_UNAVAILABLE' };
    }

    const deterministicPassed = verification.outcome === 'passed';
    if (deterministicPassed) {
      // Deterministic success stands alone; no visual diagnostic is required.
      return { available: true, observation: undefined, agreed: true };
    }

    await this.createEvent(taskId, 'VISUAL_OBSERVATION_STARTED', {
      taskId,
      stepIndex,
      actionType: action.type,
      expectedCondition: 'present',
    });

    let screenshotBase64: string | undefined;
    if (context.evidenceFilename) {
      try {
        const fullPath = resolveContainedEvidencePath(context.evidenceDir, context.evidenceFilename ?? '');
        const buffer = fs.readFileSync(fullPath);
        screenshotBase64 = buffer.toString('base64');
      } catch {
        screenshotBase64 = undefined;
      }
    }

    const actionContext = `${action.type} ${step.description ?? ''} deterministic=${verification.method}:${verification.outcome}`;
    try {
      const observation = await visualObserver.observe({
        taskId,
        screenshotBase64,
        expectedCondition: 'present',
        actionContext,
        domObservations: [verification.detail],
      });
      const agreed =
        verification.outcome !== 'failed' || observation.expectedCondition === 'absent';
      return { available: true, observation, agreed };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VISUAL_UNAVAILABLE';
      return { available: false, error: message };
    }
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
