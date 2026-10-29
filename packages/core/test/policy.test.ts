import { describe, expect, it } from 'vitest';
import { ActionPolicy, Plan, PlanSchema } from '../src/index.js';

const origin = 'http://127.0.0.1:3001';
const policy = new ActionPolicy({ allowedOrigin: origin });

function plan(steps: Plan['steps']): Plan {
  return PlanSchema.parse({ objectiveSummary: 'Test plan', steps });
}

const navigate = {
  action: { type: 'NAVIGATE' as const, payload: { url: `${origin}/` } },
  description: 'Open the demo application',
  expectation: { kind: 'visibleText' as const, value: 'GHOST Demo Application' },
};

const click = {
  action: {
    type: 'CLICK' as const,
    payload: { locator: { by: 'role' as const, role: 'button' as const, name: 'Sign in' } },
  },
  description: 'Click the Sign in button',
  expectation: { kind: 'visibleText' as const, value: 'Welcome back, demo user' },
};

const fillEmail = {
  action: {
    type: 'FILL' as const,
    payload: {
      locator: { by: 'label' as const, label: 'Email' },
      value: 'demo@example.com',
    },
  },
  description: 'Fill the email field',
  expectation: {
    kind: 'fieldValue' as const,
    locator: { by: 'label' as const, label: 'Email' },
  },
};

const screenshot = {
  action: { type: 'SCREENSHOT' as const, payload: { name: 'result' } },
  description: 'Capture the result',
  expectation: { kind: 'screenshot' as const },
};

describe('@ghost/core ActionPolicy', () => {
  it('accepts a bounded plan on the exact approved origin', () => {
    const result = policy.validatePlan(plan([navigate, fillEmail, click]));
    expect(result.allowed).toBe(true);
    expect(result.approvalSteps).toEqual([1]);
  });

  it('rejects navigation and expected URLs outside the approved origin', () => {
    const external = plan([
      {
        ...navigate,
        action: { type: 'NAVIGATE', payload: { url: 'https://evil.example/' } },
      },
      click,
    ]);
    const result = policy.validatePlan(external);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'UNAPPROVED_ORIGIN')).toBe(
      true
    );

    const externalExpectation = plan([
      navigate,
      {
        ...click,
        expectation: { kind: 'url', value: 'https://evil.example/after' },
      },
    ]);
    expect(policy.validatePlan(externalExpectation).allowed).toBe(false);
  });

  it('rejects step budgets above eight steps', () => {
    const steps = Array.from({ length: 9 }, () => ({ ...click }));
    const result = policy.validatePlan({ objectiveSummary: 'Too many', steps } as Plan);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'STEP_BUDGET_EXCEEDED')).toBe(
      true
    );
  });

  it('requires the first step to navigate to the approved origin', () => {
    const result = policy.validatePlan(plan([click]));
    expect(result.allowed).toBe(false);
    expect(
      result.violations.some((violation) => violation.code === 'PLAN_MUST_START_WITH_NAVIGATE')
    ).toBe(true);
  });

  it('rejects mismatched expectations and values repeated in plan text', () => {
    const mismatch = plan([
      navigate,
      {
        ...click,
        expectation: { kind: 'screenshot' },
      },
    ]);
    expect(
      policy
        .validatePlan(mismatch)
        .violations.some((violation) => violation.code === 'UNSUPPORTED_EXPECTATION')
    ).toBe(true);

    const leaked = plan([
      navigate,
      { ...fillEmail, description: 'Fill Email with demo@example.com' },
    ]);
    expect(
      policy
        .validatePlan(leaked)
        .violations.some((violation) => violation.code === 'SENSITIVE_VALUE_IN_TEXT')
    ).toBe(true);
  });

  it('requires approval for sensitive fields and destructive clicks', () => {
    expect(policy.evaluate(fillEmail.action)).toMatchObject({
      allowed: true,
      requiresApproval: true,
      code: 'SENSITIVE_FIELD',
    });

    const destructive = {
      type: 'CLICK' as const,
      payload: {
        locator: { by: 'role' as const, role: 'button' as const, name: 'Delete account' },
      },
    };
    expect(policy.evaluate(destructive)).toMatchObject({
      allowed: true,
      requiresApproval: true,
      code: 'HIGH_CONSEQUENCE_ACTION',
    });
  });

  it('rejects unknown action types and unsafe screenshot names', () => {
    expect(
      policy.evaluate({ type: 'SHELL', payload: { cmd: 'rm -rf /' } } as never).allowed
    ).toBe(false);

    const unsafe = {
      action: { type: 'SCREENSHOT' as const, payload: { name: '../escape' } },
      description: 'Unsafe screenshot',
      expectation: { kind: 'screenshot' as const },
    };
    expect(PlanSchema.safeParse({ objectiveSummary: 'x', steps: [unsafe] }).success).toBe(false);
  });

  it('requires a screenshot step when the objective asks for one', () => {
    const objective = 'Open the demo, click Sign in, and capture a screenshot.';
    const withoutShot = policy.validatePlan(plan([navigate, click]), { objective });
    expect(withoutShot.allowed).toBe(false);
    expect(
      withoutShot.violations.some(
        (violation) => violation.code === 'MISSING_REQUIRED_SCREENSHOT'
      )
    ).toBe(true);

    const withShot = policy.validatePlan(plan([navigate, click, screenshot]), { objective });
    expect(withShot.allowed).toBe(true);

    // An objective that does not request a screenshot does not require one.
    expect(policy.validatePlan(plan([navigate, click])).allowed).toBe(true);
  });

  it('rejects click expectations that only restate the clicked control', () => {
    const sameElement = plan([
      navigate,
      {
        ...click,
        expectation: {
          kind: 'elementVisible',
          locator: { by: 'role', role: 'button', name: 'Sign in' },
        },
      },
    ]);
    expect(
      policy
        .validatePlan(sameElement)
        .violations.some((violation) => violation.code === 'WEAK_CLICK_POSTCONDITION')
    ).toBe(true);

    const sameText = plan([
      navigate,
      { ...click, expectation: { kind: 'visibleText', value: 'Sign in' } },
    ]);
    expect(
      policy
        .validatePlan(sameText)
        .violations.some((violation) => violation.code === 'WEAK_CLICK_POSTCONDITION')
    ).toBe(true);
  });
});
