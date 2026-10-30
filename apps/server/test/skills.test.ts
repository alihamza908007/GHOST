import { describe, expect, it } from 'vitest';
import { PlanSchema } from '@ghost/core';
import { deriveSkillFromPlan, validateSkillDefinition } from '../src/skills.js';

const baseDefinition = {
  name: 'Sign in',
  description: 'Fill the demo form',
  inputs: [{ name: 'email', type: 'string', required: true }],
  steps: [
    {
      action: { type: 'NAVIGATE', payload: { url: 'http://127.0.0.1:3001' } },
      description: 'Open the demo',
      expectation: { kind: 'visibleText', value: 'GHOST Demo Application' },
    },
    {
      action: {
        type: 'FILL',
        payload: { locator: { by: 'label', label: 'Email' }, value: '{{email}}' },
      },
      description: 'Fill the email field',
      expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
    },
  ],
};

describe('validateSkillDefinition', () => {
  it('accepts a well-formed definition with declared placeholders', () => {
    const result = validateSkillDefinition(baseDefinition);
    expect('definition' in result).toBe(true);
    if ('definition' in result) {
      expect(result.definition.steps).toHaveLength(2);
      expect(result.definition.inputs[0]?.name).toBe('email');
    }
  });

  it('rejects an undeclared placeholder', () => {
    const result = validateSkillDefinition({
      ...baseDefinition,
      inputs: [],
    });
    expect(result).toEqual({ error: expect.stringContaining('Undeclared placeholder') });
  });

  it('rejects unsupported action types', () => {
    const result = validateSkillDefinition({
      name: 'Bad',
      inputs: [],
      steps: [
        {
          action: { type: 'EVALUATE', payload: { script: 'alert(1)' } },
          description: 'run script',
          expectation: { kind: 'screenshot' },
        },
      ],
    });
    expect('error' in result).toBe(true);
  });

  it('rejects invalid locator shapes', () => {
    const result = validateSkillDefinition({
      name: 'Bad locator',
      inputs: [],
      steps: [
        {
          action: { type: 'CLICK', payload: { locator: { by: 'css', selector: 'button' } } },
          description: 'click',
          expectation: { kind: 'screenshot' },
        },
      ],
    });
    expect('error' in result).toBe(true);
  });

  it('rejects duplicate input names', () => {
    const result = validateSkillDefinition({
      ...baseDefinition,
      inputs: [
        { name: 'email', type: 'string' },
        { name: 'email', type: 'string' },
      ],
    });
    expect('error' in result).toBe(true);
  });
});

describe('deriveSkillFromPlan', () => {
  it('turns fill values into inputs and preserves other steps', () => {
    const plan = PlanSchema.parse({
      objectiveSummary: 'Sign in and capture evidence',
      steps: [
        {
          action: { type: 'NAVIGATE', payload: { url: 'http://127.0.0.1:3001' } },
          description: 'Open demo',
          expectation: { kind: 'url', value: 'http://127.0.0.1:3001' },
        },
        {
          action: {
            type: 'FILL',
            payload: { locator: { by: 'label', label: 'Email' }, value: 'demo@example.com' },
          },
          description: 'Fill email',
          expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
        },
        {
          action: {
            type: 'FILL',
            payload: { locator: { by: 'label', label: 'Password' }, value: 'hunter2' },
          },
          description: 'Fill password',
          expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Password' } },
        },
        {
          action: { type: 'SCREENSHOT', payload: { name: 'result' } },
          description: 'Capture',
          expectation: { kind: 'screenshot' },
        },
      ],
    });

    const { definition, inputNames } = deriveSkillFromPlan('task-1', plan, 'Auto skill');
    expect(inputNames).toEqual(['email', 'password']);
    const fills = definition.steps.filter((step) => step.action.type === 'FILL');
    expect(fills).toHaveLength(2);
    expect((fills[0]!.action.payload as { value: string }).value).toBe('{{email}}');
    expect((fills[1]!.action.payload as { value: string }).value).toBe('{{password}}');
    expect(definition.steps[0]!.action.type).toBe('NAVIGATE');
    expect(definition.steps[3]!.action.type).toBe('SCREENSHOT');
    const validated = validateSkillDefinition(definition);
    expect('definition' in validated).toBe(true);
  });

  it('deduplicates inputs derived from identical labels', () => {
    const plan = PlanSchema.parse({
      objectiveSummary: 'Twice',
      steps: [
        {
          action: {
            type: 'FILL',
            payload: { locator: { by: 'label', label: 'Email' }, value: 'a@example.com' },
          },
          description: 'First email',
          expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
        },
        {
          action: {
            type: 'FILL',
            payload: { locator: { by: 'label', label: 'Email' }, value: 'b@example.com' },
          },
          description: 'Second email',
          expectation: { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
        },
      ],
    });
    const { inputNames } = deriveSkillFromPlan('task-2', plan, 'Dup');
    expect(inputNames).toEqual(['email', 'email_2']);
  });
});
