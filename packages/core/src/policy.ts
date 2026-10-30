import {
  Action,
  ActionSchema,
  LIMITS,
  Locator,
  Plan,
  PlanStep,
} from './schema.js';
import { RecoveryAction } from './types.js';

export type PolicyCode =
  | 'INVALID_ACTION'
  | 'UNAPPROVED_ORIGIN'
  | 'UNSUPPORTED_EXPECTATION'
  | 'STEP_BUDGET_EXCEEDED'
  | 'ACTION_BUDGET_EXCEEDED'
  | 'PLAN_MUST_START_WITH_NAVIGATE'
  | 'TOO_MANY_NAVIGATIONS'
  | 'SENSITIVE_VALUE_IN_TEXT'
  | 'EMPTY_PLAN'
  | 'SENSITIVE_FIELD'
  | 'HIGH_CONSEQUENCE_ACTION'
  | 'MISSING_REQUIRED_SCREENSHOT'
  | 'WEAK_CLICK_POSTCONDITION'
  | 'RECOVERY_UNAUTHORIZED';

export interface PlanPolicyOptions {
  /** Used only for deterministic coverage checks, never as model input. */
  objective?: string;
  /** Task-scoped authorization snapshot; defaults to the policy allowlist. */
  origins?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  code?: PolicyCode;
  reason?: string;
}

export interface PlanPolicyResult {
  allowed: boolean;
  requiresApproval: boolean;
  approvalSteps: number[];
  violations: Array<{ stepIndex: number | null; code: PolicyCode; message: string }>;
}

export interface ActionPolicyOptions {
  allowedOrigin?: string;
  allowedOrigins?: string[];
  maxSteps?: number;
  maxActions?: number;
  maxNavigations?: number;
  maxRecoveryAttempts?: number;
  maxRetriesPerAction?: number;
  sensitiveFieldPattern?: RegExp;
  highConsequenceClickPattern?: RegExp;
}

const DEFAULT_SENSITIVE_FIELD =
  /pass(word|code)?|secret|token|ssn|social.?security|credit.?card|card.?number|routing|bank|iban|email/i;
const DEFAULT_HIGH_CONSEQUENCE_CLICK =
  /delete|remove.?account|purchase|buy.?now|pay|transfer|wire|checkout|place.?order|confirm.?payment/i;

export function locatorText(locator: {
  by: 'role' | 'label' | 'testId';
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
}): string {
  if (locator.by === 'role') return `${locator.role ?? ''} ${locator.name ?? ''}`.trim();
  if (locator.by === 'label') return locator.label ?? '';
  return locator.testId ?? '';
}

function expectationMatchesAction(step: PlanStep): boolean {
  const kind = step.expectation.kind;
  switch (step.action.type) {
    case 'NAVIGATE':
      return kind === 'url' || kind === 'visibleText' || kind === 'elementVisible';
    case 'CLICK':
      return kind === 'url' || kind === 'visibleText' || kind === 'elementVisible';
    case 'FILL':
      return kind === 'fieldValue' || kind === 'visibleText' || kind === 'elementVisible';
    case 'SCREENSHOT':
      return kind === 'screenshot';
    default:
      return false;
  }
}

export function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizeOrigins(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const n = normalizeOrigin(v);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function isAllowedUrl(url: string, allowedOrigins: string | string[]): boolean {
  const set = normalizeOrigins(Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]);
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return set.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function actionsEqual(a: Action, b: Action): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SCREENSHOT_OBJECTIVE =
  /\b(screenshot|screen\s?shot|capture\s+(?:a\s+)?(?:screen|screenshot|page|image|evidence))\b/i;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function locatorsEqual(a: Locator, b: Locator): boolean {
  if (a.by !== b.by) return false;
  if (a.by === 'role' && b.by === 'role') return a.role === b.role && a.name === b.name;
  if (a.by === 'label' && b.by === 'label') return a.label === b.label;
  if (a.by === 'testId' && b.by === 'testId') return a.testId === b.testId;
  return false;
}

function locatorTargetText(locator: Locator): string {
  if (locator.by === 'role') return locator.name;
  if (locator.by === 'label') return locator.label;
  return locator.testId;
}

/**
 * Deterministic policy shared by the planner (pre-flight validation) and the
 * engine (pre-action authorization). The model cannot influence these limits.
 */
export class ActionPolicy {
  readonly allowedOrigins: string[];
  readonly maxSteps: number;
  readonly maxActions: number;
  readonly maxNavigations: number;
  readonly maxRecoveryAttempts: number;
  readonly maxRetriesPerAction: number;
  private readonly sensitiveFieldPattern: RegExp;
  private readonly highConsequenceClickPattern: RegExp;

  constructor(options: ActionPolicyOptions) {
    const origins = normalizeOrigins([
      ...(options.allowedOrigins ?? []),
      options.allowedOrigin,
    ]);
    if (origins.length === 0) {
      throw new Error('ActionPolicy requires at least one approved origin');
    }
    this.allowedOrigins = origins;
    this.maxSteps = options.maxSteps ?? LIMITS.MAX_PLAN_STEPS;
    this.maxActions = options.maxActions ?? LIMITS.MAX_EXECUTED_ACTIONS;
    this.maxNavigations = options.maxNavigations ?? 3;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? LIMITS.MAX_RECOVERY_ATTEMPTS;
    this.maxRetriesPerAction = options.maxRetriesPerAction ?? LIMITS.MAX_RECOVERY_RETRIES_PER_ACTION;
    this.sensitiveFieldPattern = options.sensitiveFieldPattern ?? DEFAULT_SENSITIVE_FIELD;
    this.highConsequenceClickPattern =
      options.highConsequenceClickPattern ?? DEFAULT_HIGH_CONSEQUENCE_CLICK;
  }

  get allowedOrigin(): string {
    return this.allowedOrigins[0];
  }

  /** Re-validate a single action against schema and origin policy. */
  evaluate(action: Action, origins?: string[]): PolicyDecision {
    const parsed = ActionSchema.safeParse(action);
    if (!parsed.success) {
      return {
        allowed: false,
        requiresApproval: false,
        code: 'INVALID_ACTION',
        reason: 'Action does not match the registered action schema',
      };
    }

    const valid = parsed.data;
    const effectiveOrigins = origins && origins.length > 0 ? normalizeOrigins(origins) : this.allowedOrigins;

    if (valid.type === 'NAVIGATE' && !isAllowedUrl(valid.payload.url, effectiveOrigins)) {
      return {
        allowed: false,
        requiresApproval: false,
        code: 'UNAPPROVED_ORIGIN',
        reason: 'Navigation target is outside the configured demo origin',
      };
    }

    if (valid.type === 'SCREENSHOT' && !/^[a-zA-Z0-9_-]{1,40}$/.test(valid.payload.name)) {
      return {
        allowed: false,
        requiresApproval: false,
        code: 'INVALID_ACTION',
        reason: 'Screenshot name is not a safe slug',
      };
    }

    if (valid.type === 'FILL') {
      const label = locatorText(valid.payload.locator);
      if (this.sensitiveFieldPattern.test(label)) {
        return {
          allowed: true,
          requiresApproval: true,
          code: 'SENSITIVE_FIELD',
          reason: `Filling a sensitive field requires explicit approval: ${label}`,
        };
      }
    }
    if (valid.type === 'CLICK') {
      const label = locatorText(valid.payload.locator);
      if (this.highConsequenceClickPattern.test(label)) {
        return {
          allowed: true,
          requiresApproval: true,
          code: 'HIGH_CONSEQUENCE_ACTION',
          reason: `Clicking this control requires explicit approval: ${label}`,
        };
      }
    }

    return { allowed: true, requiresApproval: false };
  }

  /**
   * Policy gate for the narrow recovery catalog. Recovery dismissals must
   * reference an allowlisted semantic close control and stay inside the
   * approved origin. Retries are authorized through the normal action policy
   * for the referenced step by the engine.
   */
  authorizeRecovery(
    action: RecoveryAction,
    options: { allowedOrigins: string[]; recoveryCloseAllowlist: string[] }
  ): PolicyDecision {
    if (action.kind === 'DISMISS_OVERLAY') {
      const locator = action.locator;
      const closeName =
        locator.by === 'role'
          ? (locator.name ?? '').toLowerCase()
          : locator.by === 'testId'
            ? (locator.testId ?? '').toLowerCase()
            : (locator.label ?? '').toLowerCase();
      const allowlist = (options.recoveryCloseAllowlist ?? [])
        .map((entry) => (entry.startsWith('testid:') ? entry.slice('testid:'.length).toLowerCase() : entry.toLowerCase()))
        .filter((entry) => entry.length > 0);
      const allowed = allowlist.some((entry) => entry.length > 0 && entry === closeName);
      if (!allowed) {
        return {
          allowed: false,
          requiresApproval: false,
          code: 'RECOVERY_UNAUTHORIZED',
          reason: 'Overlay dismissal is not on the recovery allowlist',
        };
      }
      return {
        allowed: true,
        requiresApproval: false,
        code: undefined,
        reason: 'Overlay dismissal is authorized by the recovery allowlist',
      };
    }

    return {
      allowed: false,
      requiresApproval: false,
      code: 'RECOVERY_UNAUTHORIZED',
      reason: 'Retry recovery must be authorized through the action policy for the referenced step',
    };
  }

  /**
   * Pre-flight plan validation. This is intentionally independent of the LLM
   * and runs before any browser process is launched.
   */
  validatePlan(plan: Plan, options: PlanPolicyOptions = {}): PlanPolicyResult {
    const violations: PlanPolicyResult['violations'] = [];
    const approvalSteps: number[] = [];
    const origins =
      options.origins && options.origins.length > 0 ? normalizeOrigins(options.origins) : this.allowedOrigins;

    if (plan.steps.length === 0) {
      violations.push({
        stepIndex: null,
        code: 'EMPTY_PLAN',
        message: 'The objective cannot be planned with the supported actions',
      });
      return { allowed: false, requiresApproval: false, approvalSteps, violations };
    }

    if (plan.steps.length > this.maxSteps) {
      violations.push({
        stepIndex: null,
        code: 'STEP_BUDGET_EXCEEDED',
        message: `Plan exceeds the ${this.maxSteps}-step limit`,
      });
    }

    if (plan.steps.length > this.maxActions) {
      violations.push({
        stepIndex: null,
        code: 'ACTION_BUDGET_EXCEEDED',
        message: `Plan exceeds the ${this.maxActions}-action limit`,
      });
    }

    if (plan.steps[0]?.action.type !== 'NAVIGATE') {
      violations.push({
        stepIndex: 0,
        code: 'PLAN_MUST_START_WITH_NAVIGATE',
        message: 'The first step must navigate to the configured demo origin',
      });
    } else if (!isAllowedUrl(plan.steps[0].action.payload.url, origins)) {
      violations.push({
        stepIndex: 0,
        code: 'UNAPPROVED_ORIGIN',
        message: 'Navigation target is outside the approved origin set',
      });
    }

    const navigations = plan.steps.filter((step) => step.action.type === 'NAVIGATE').length;
    if (navigations > this.maxNavigations) {
      violations.push({
        stepIndex: null,
        code: 'TOO_MANY_NAVIGATIONS',
        message: `Plan exceeds the ${this.maxNavigations}-navigation limit`,
      });
    }

    if (
      options.objective &&
      SCREENSHOT_OBJECTIVE.test(options.objective) &&
      !plan.steps.some((step) => step.action.type === 'SCREENSHOT')
    ) {
      violations.push({
        stepIndex: null,
        code: 'MISSING_REQUIRED_SCREENSHOT',
        message: 'The objective requests a screenshot; the plan must include a SCREENSHOT step',
      });
    }

    plan.steps.forEach((step: PlanStep, stepIndex: number) => {
      const actionDecision = this.evaluate(step.action, origins);
      if (!actionDecision.allowed) {
        violations.push({
          stepIndex,
          code: actionDecision.code ?? 'INVALID_ACTION',
          message: actionDecision.reason ?? 'Action rejected by policy',
        });
      } else if (actionDecision.requiresApproval) {
        approvalSteps.push(stepIndex);
      }

      if (!expectationMatchesAction(step)) {
        violations.push({
          stepIndex,
          code: 'UNSUPPORTED_EXPECTATION',
          message: `Expectation "${step.expectation.kind}" cannot verify action ${step.action.type}`,
        });
      }

      if (step.action.type === 'CLICK') {
        const locator = step.action.payload.locator;
        const target = normalizeText(locatorTargetText(locator));
        const repeatsTarget =
          (step.expectation.kind === 'elementVisible' &&
            locatorsEqual(step.expectation.locator, locator)) ||
          (step.expectation.kind === 'visibleText' &&
            normalizeText(step.expectation.value) === target);

        if (repeatsTarget) {
          violations.push({
            stepIndex,
            code: 'WEAK_CLICK_POSTCONDITION',
            message:
              'The click expectation only restates the clicked control; use a postcondition such as a result message or changed URL',
          });
        }
      }

      if (
        step.expectation.kind === 'url' &&
        !isAllowedUrl(step.expectation.value, origins)
      ) {
        violations.push({
          stepIndex,
          code: 'UNAPPROVED_ORIGIN',
          message: 'Expected URL is outside the configured demo origin',
        });
      }

      if (step.action.type === 'NAVIGATE' && !isAllowedUrl(step.action.payload.url, origins)) {
        violations.push({
          stepIndex,
          code: 'UNAPPROVED_ORIGIN',
          message: 'Navigation target is outside the approved origin set',
        });
      }

      if (step.action.type === 'FILL') {
        const value = step.action.payload.value;
        const text = `${step.description} ${step.rationale ?? ''}`;
        if (value.length >= 4 && text.includes(value)) {
          violations.push({
            stepIndex,
            code: 'SENSITIVE_VALUE_IN_TEXT',
            message: 'Plan text repeats a form value; values must not be persisted in descriptions',
          });
        }
      }
    });

    return {
      allowed: violations.length === 0,
      requiresApproval: approvalSteps.length > 0,
      approvalSteps,
      violations,
    };
  }
}
