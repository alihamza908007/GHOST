import { ActionPolicy, LIMITS, Plan, PlanSchema } from '@ghost/core';
import { buildPlanJsonSchema, buildPlanningPrompt, PlanningContext } from './prompt.js';
import {
  isModelError,
  ModelError,
  ModelProvider,
  StructuredGenerationResult,
} from './types.js';

export type PlanningErrorCode =
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_TIMEOUT'
  | 'MODEL_CANCELLED'
  | 'MALFORMED_OUTPUT'
  | 'GENERATION_FAILED'
  | 'INVALID_PLAN'
  | 'POLICY_VIOLATION'
  | 'OBJECTIVE_UNSUPPORTED';

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  readonly attempts: number;
  /** Safe, bounded validation messages; never model chain-of-thought. */
  readonly issues: string[];

  constructor(code: PlanningErrorCode, message: string, attempts: number, issues: string[] = []) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.attempts = attempts;
    this.issues = issues;
  }
}

export interface PlannerOptions {
  policy: ActionPolicy;
  maxAttempts?: number;
  /** Test seam; defaults to the schema builder. */
  jsonSchema?: Record<string, unknown>;
}

export interface PlannerResult {
  plan: Plan;
  attempts: number;
  latencyMs: number;
  model: string;
}

export interface PlanRequestOptions {
  requestId: string;
  signal?: AbortSignal;
}

function zodIssues(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return ['Invalid plan'];
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> })
    .issues;
  if (!Array.isArray(issues)) return ['Invalid plan'];
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`);
}

/**
 * LLM proposes -> Zod validates -> policy authorizes. The planner stops here;
 * execution is a separate, policy-checked step in the engine.
 */
export class StructuredPlanner {
  private readonly provider: ModelProvider;
  private readonly policy: ActionPolicy;
  private readonly maxAttempts: number;
  private readonly jsonSchema: Record<string, unknown>;

  constructor(provider: ModelProvider, options: PlannerOptions) {
    this.provider = provider;
    this.policy = options.policy;
    this.maxAttempts = Math.min(
      options.maxAttempts ?? LIMITS.MAX_PLANNER_ATTEMPTS,
      LIMITS.MAX_PLANNER_ATTEMPTS
    );
    this.jsonSchema = options.jsonSchema ?? buildPlanJsonSchema();
  }

  cancel(requestId: string): void {
    this.provider.cancel(requestId);
  }

  async plan(context: PlanningContext, options: PlanRequestOptions): Promise<PlannerResult> {
    const startedAt = Date.now();
    let correction: string | undefined;
    let lastError: PlanningError | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      const prompt = buildPlanningPrompt(context, {
        allowedOrigin: this.policy.allowedOrigin,
        allowedOrigins: this.policy.allowedOrigins,
        correction,
      });

      let generation: StructuredGenerationResult;
      try {
        generation = await this.provider.generateStructured({
          requestId: options.requestId,
          system: prompt.system,
          user: prompt.user,
          jsonSchema: this.jsonSchema,
          signal: options.signal,
        });
      } catch (error) {
        if (isModelError(error)) {
          lastError = mapModelError(error, attempts);
          if (error.code === 'MALFORMED_OUTPUT' && attempt < this.maxAttempts) {
            correction = 'The response was not valid JSON. Return only a JSON object.';
            continue;
          }
          throw lastError;
        }
        throw new PlanningError(
          'GENERATION_FAILED',
          'The planner model request failed safely',
          attempts
        );
      }

      const parsed = PlanSchema.safeParse(generation.json);
      if (!parsed.success) {
        const issues = zodIssues(parsed.error);
        lastError = new PlanningError(
          'INVALID_PLAN',
          'The model returned a plan that did not match the plan contract',
          attempts,
          issues
        );
        correction = `Schema violations: ${issues.join('; ')}.`;
        continue;
      }

      const plan = parsed.data;
      const policyResult = this.policy.validatePlan(plan, {
        objective: context.objective,
      });
      if (!policyResult.allowed) {
        const issues = policyResult.violations.map(
          (violation) =>
            `${violation.stepIndex === null ? 'plan' : `step ${violation.stepIndex}`}: ${
              violation.code
            } - ${violation.message}`
        );
        const unsupported =
          policyResult.violations.length === 1 &&
          policyResult.violations[0]?.code === 'EMPTY_PLAN';
        lastError = new PlanningError(
          unsupported ? 'OBJECTIVE_UNSUPPORTED' : 'POLICY_VIOLATION',
          unsupported
            ? 'The objective cannot be expressed with the supported demo actions'
            : 'The proposed plan was rejected by deterministic policy',
          attempts,
          issues
        );
        correction = `Policy violations: ${issues.join('; ')}.`;
        continue;
      }

      return {
        plan,
        attempts,
        latencyMs: Date.now() - startedAt,
        model: generation.model,
      };
    }

    throw (
      lastError ??
      new PlanningError('INVALID_PLAN', 'The planner did not produce a valid plan', attempts)
    );
  }
}

function mapModelError(error: ModelError, attempts: number): PlanningError {
  switch (error.code) {
    case 'MODEL_NOT_FOUND':
    case 'CONNECTION_FAILED':
      return new PlanningError('MODEL_UNAVAILABLE', error.message, attempts);
    case 'TIMEOUT':
      return new PlanningError('MODEL_TIMEOUT', error.message, attempts);
    case 'CANCELLED':
      return new PlanningError('MODEL_CANCELLED', 'Planning was cancelled', attempts);
    case 'MALFORMED_OUTPUT':
      return new PlanningError('MALFORMED_OUTPUT', error.message, attempts);
    case 'UNSUPPORTED_IMAGE_INPUT':
      return new PlanningError(
        'MODEL_UNAVAILABLE',
        'The configured planner model does not support the requested modality',
        attempts
      );
    case 'INVALID_REQUEST':
      return new PlanningError('INVALID_PLAN', error.message, attempts);
    default:
      return new PlanningError('GENERATION_FAILED', error.message, attempts);
  }
}
