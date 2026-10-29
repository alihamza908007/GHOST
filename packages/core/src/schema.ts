import { z } from 'zod';

/**
 * Phase 2 hard limits. These are application constants, not model input.
 * The planner and the engine both enforce them independently.
 */
export const LIMITS = {
  MAX_PLAN_STEPS: 8,
  MAX_EXECUTED_ACTIONS: 15,
  MAX_PLANNER_ATTEMPTS: 2,
  MAX_OBJECTIVE_CHARS: 1_000,
  MAX_SUMMARY_CHARS: 200,
  MAX_DESCRIPTION_CHARS: 240,
  MAX_RATIONALE_CHARS: 300,
  MAX_EXPECTATION_TEXT_CHARS: 200,
  MAX_LOCATOR_VALUE_CHARS: 100,
  MAX_FILL_VALUE_CHARS: 500,
  MAX_RECOVERY_ATTEMPTS: 2,
  MAX_RECOVERY_RETRIES_PER_ACTION: 1,
} as const;

export const TaskStatusSchema = z.enum([
  'IDLE',
  'PLANNING',
  'PLAN_READY',
  'EXECUTING',
  'VERIFYING',
  'RETRYING',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DEGRADED',
]);

export const TaskSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: TaskStatusSchema,
  currentStepIndex: z.number(),
  lastEventId: z.string().nullable(),
});

const BoundedText = (max: number) => z.string().trim().min(1).max(max);

/**
 * Semantic locators only. There is deliberately no CSS/XPath/JS locator
 * variant, so a model cannot smuggle an arbitrary selector or script into the
 * browser tool layer.
 */
export const LocatorSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('role'),
      role: z.enum([
        'button',
        'link',
        'textbox',
        'checkbox',
        'combobox',
        'heading',
        'menuitem',
        'tab',
      ]),
      name: BoundedText(LIMITS.MAX_LOCATOR_VALUE_CHARS),
    })
    .strict(),
  z
    .object({
      by: z.literal('label'),
      label: BoundedText(LIMITS.MAX_LOCATOR_VALUE_CHARS),
    })
    .strict(),
  z
    .object({
      by: z.literal('testId'),
      testId: BoundedText(LIMITS.MAX_LOCATOR_VALUE_CHARS),
    })
    .strict(),
]);

export const ActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('NAVIGATE'),
      payload: z.object({ url: z.string().url().max(2_048) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('CLICK'),
      payload: z.object({ locator: LocatorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('FILL'),
      payload: z
        .object({
          locator: LocatorSchema,
          value: z.string().min(1).max(LIMITS.MAX_FILL_VALUE_CHARS),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('SCREENSHOT'),
      payload: z
        .object({
          name: z
            .string()
            .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Screenshot name must be a safe slug'),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * A deterministic postcondition. The verifier evaluates these against the
 * live DOM; a resolved Playwright call is never treated as proof.
 */
export const ExpectationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('url'),
      value: z.string().url().max(2_048),
    })
    .strict(),
  z
    .object({
      kind: z.literal('visibleText'),
      value: BoundedText(LIMITS.MAX_EXPECTATION_TEXT_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('elementVisible'),
      locator: LocatorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('fieldValue'),
      locator: LocatorSchema,
    })
    .strict(),
  z.object({ kind: z.literal('screenshot') }).strict(),
]);

export const PlanStepSchema = z
  .object({
    action: ActionSchema,
    description: BoundedText(LIMITS.MAX_DESCRIPTION_CHARS),
    expectation: ExpectationSchema,
    rationale: z.string().trim().max(LIMITS.MAX_RATIONALE_CHARS).optional(),
  })
  .strict();

export const PlanSchema = z
  .object({
    objectiveSummary: BoundedText(LIMITS.MAX_SUMMARY_CHARS),
    steps: z.array(PlanStepSchema).max(LIMITS.MAX_PLAN_STEPS),
    rationale: z.string().trim().max(LIMITS.MAX_RATIONALE_CHARS).optional(),
  })
  .strict();

export type Locator = z.infer<typeof LocatorSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];
export type Expectation = z.infer<typeof ExpectationSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const EventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.string(),
  timestamp: z.number(),
  seq: z.number().optional(),
  // Zod 4 requires an explicit key type for z.record.
  data: z.record(z.string(), z.unknown()),
});

export const EvidenceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.literal('screenshot'),
  filename: z.string(),
  timestamp: z.number(),
  size: z.number().int().nonnegative().optional(),
});

export const ApprovalDecisionSchema = z.enum(['approve', 'reject']);
