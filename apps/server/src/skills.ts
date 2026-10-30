import type { Plan, PlanStep } from '@ghost/core';

export interface SkillInputSpec {
  name: string;
  type: 'string' | 'number';
  description?: string;
  required?: boolean;
  maxLength?: number;
}

export interface SkillDefinition {
  name: string;
  description?: string;
  objective?: string;
  inputs: SkillInputSpec[];
  steps: PlanStep[];
}

export interface SkillDerivation {
  definition: SkillDefinition;
  inputNames: string[];
}

const ACTION_TYPES = new Set(['NAVIGATE', 'CLICK', 'FILL', 'SCREENSHOT']);
const LOCATOR_KINDS = new Set(['role', 'label', 'testId']);
const EXPECTATION_KINDS = new Set(['url', 'visibleText', 'elementVisible', 'fieldValue', 'screenshot']);
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function validLocator(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const by = value.by;
  if (typeof by !== 'string' || !LOCATOR_KINDS.has(by)) return false;
  if (by === 'role') {
    return (
      typeof value.role === 'string' &&
      ['button', 'link', 'textbox', 'checkbox', 'combobox', 'heading', 'menuitem', 'tab'].includes(
        value.role
      ) &&
      typeof value.name === 'string' &&
      value.name.trim().length > 0
    );
  }
  if (by === 'label') return typeof value.label === 'string' && value.label.trim().length > 0;
  return typeof value.testId === 'string' && value.testId.trim().length > 0;
}

function collectPlaceholders(value: unknown, target: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) target.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, target);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectPlaceholders(item, target);
  }
}

/**
 * Structural validation for user-authored skills. Deliberately lenient about
 * URLs/text containing `{{input}}` placeholders because substitution happens
 * at run time, but strict about action shape so the engine never receives an
 * unvalidated payload.
 */
export function validateSkillDefinition(value: unknown): { definition: SkillDefinition } | { error: string } {
  if (!isRecord(value)) return { error: 'Definition must be an object.' };

  const name = nonEmptyString(value.name, 120);
  if (!name) return { error: 'Definition name must be 1-120 characters.' };

  const rawInputs = value.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > 20) {
    return { error: 'Inputs must be an array of at most 20 entries.' };
  }
  const inputs: SkillInputSpec[] = [];
  const inputNames = new Set<string>();
  for (const [index, raw] of rawInputs.entries()) {
    if (!isRecord(raw)) return { error: `Input ${index + 1} must be an object.` };
    const inputName = nonEmptyString(raw.name, 40);
    if (!inputName || !INPUT_NAME.test(inputName)) {
      return { error: `Input ${index + 1} has an invalid name. Use letters, numbers, and underscores.` };
    }
    if (inputNames.has(inputName)) return { error: `Input "${inputName}" is declared twice.` };
    inputNames.add(inputName);
    const type = raw.type === 'number' ? 'number' : 'string';
    const spec: SkillInputSpec = {
      name: inputName,
      type,
      required: raw.required !== false,
    };
    if (typeof raw.description === 'string' && raw.description.trim()) {
      spec.description = raw.description.trim().slice(0, 200);
    }
    if (typeof raw.maxLength === 'number' && Number.isFinite(raw.maxLength)) {
      spec.maxLength = Math.min(Math.max(Math.trunc(raw.maxLength), 1), 10_000);
    }
    inputs.push(spec);
  }

  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { error: 'At least one step is required.' };
  }
  if (rawSteps.length > 20) return { error: 'A skill can contain at most 20 steps.' };

  const steps: PlanStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const label = `Step ${index + 1}`;
    if (!isRecord(raw) || !isRecord(raw.action)) return { error: `${label} must have an action object.` };
    const action = raw.action;
    const type = action.type;
    if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
      return { error: `${label} has an unsupported action type.` };
    }
    const payload = action.payload;
    if (!isRecord(payload)) return { error: `${label} must have a payload object.` };

    if (type === 'NAVIGATE') {
      const url = nonEmptyString(payload.url, 2_048);
      if (!url) return { error: `${label} needs a URL.` };
    } else if (type === 'CLICK') {
      if (!validLocator(payload.locator)) return { error: `${label} needs a valid locator.` };
    } else if (type === 'FILL') {
      if (!validLocator(payload.locator)) return { error: `${label} needs a valid locator.` };
      const fillValue = nonEmptyString(payload.value, 10_000);
      if (!fillValue) return { error: `${label} needs a value.` };
    } else {
      const shotName = nonEmptyString(payload.name, 40);
      if (!shotName || !/^[a-zA-Z0-9_-]+$/.test(shotName)) {
        return { error: `${label} needs a safe screenshot name.` };
      }
    }

    const description = nonEmptyString(raw.description, 500);
    if (!description) return { error: `${label} needs a description.` };

    const expectation = raw.expectation;
    if (!isRecord(expectation) || typeof expectation.kind !== 'string') {
      return { error: `${label} needs an expectation.` };
    }
    if (!EXPECTATION_KINDS.has(expectation.kind)) {
      return { error: `${label} has an unsupported expectation kind.` };
    }
    if ((expectation.kind === 'url' || expectation.kind === 'visibleText') && !nonEmptyString(expectation.value, 2_048)) {
      return { error: `${label} expectation needs a value.` };
    }
    if (
      (expectation.kind === 'elementVisible' || expectation.kind === 'fieldValue') &&
      !validLocator(expectation.locator)
    ) {
      return { error: `${label} expectation needs a valid locator.` };
    }

    steps.push({
      action: { type, payload } as PlanStep['action'],
      description,
      expectation: expectation as PlanStep['expectation'],
    });
  }

  const placeholders = new Set<string>();
  collectPlaceholders(steps, placeholders);
  const undeclared = [...placeholders].filter((item) => !inputNames.has(item));
  if (undeclared.length > 0) {
    return { error: `Undeclared placeholder(s): ${undeclared.join(', ')}. Add matching inputs first.` };
  }

  const definition: SkillDefinition = { name, inputs, steps };
  if (typeof value.description === 'string' && value.description.trim()) {
    definition.description = value.description.trim().slice(0, 500);
  }
  if (typeof value.objective === 'string' && value.objective.trim()) {
    definition.objective = value.objective.trim().slice(0, 1_000);
  }
  return { definition };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function inputNameForStep(step: PlanStep, used: Set<string>): string {
  const payload = step.action.payload as { locator?: { label?: string; name?: string; testId?: string } };
  const locator = payload.locator;
  const base =
    slug(locator?.label ?? locator?.name ?? locator?.testId ?? '') ||
    slug(step.description) ||
    'value';
  let candidate = base || 'value';
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`.slice(0, 40);
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Turns a verified task plan into a reusable skill by converting every concrete
 * FILL value into a declared input parameter. Secrets are replaced by a
 * placeholder before they reach storage.
 */
export function deriveSkillFromPlan(
  taskId: string,
  plan: Plan,
  name: string,
  description?: string | null
): SkillDerivation {
  const used = new Set<string>();
  const inputs: SkillInputSpec[] = [];

  const steps = plan.steps.map((step) => {
    if (step.action.type !== 'FILL') return step;
    const inputName = inputNameForStep(step, used);
    const locator = step.action.payload.locator as
      | { label?: string; name?: string; testId?: string }
      | undefined;
    const humanLabel = locator?.label ?? locator?.name ?? locator?.testId ?? inputName;
    inputs.push({
      name: inputName,
      type: 'string',
      required: true,
      description: `Value for ${humanLabel}`,
      maxLength: 500,
    });
    return {
      ...step,
      action: {
        ...step.action,
        payload: { ...step.action.payload, value: `{{${inputName}}}` },
      },
    } as PlanStep;
  });

  const definition: SkillDefinition = {
    name,
    description: description ?? plan.objectiveSummary,
    objective: `Skill from ${taskId}`,
    inputs,
    steps,
  };
  return { definition, inputNames: inputs.map((input) => input.name) };
}
