import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { verifyAction, VerificationContext } from '../src/verification.js';

const origin = 'http://127.0.0.1:3001';
const taskId = 'task-verify';

function fakeLocator(options: { visible?: boolean; value?: string } = {}) {
  const locator: Record<string, unknown> = {};
  locator.first = () => locator;
  locator.waitFor = async () => {
    if (options.visible === false) throw new Error('not visible');
  };
  locator.inputValue = async () => options.value ?? '';
  locator.click = async () => undefined;
  locator.fill = async () => undefined;
  return locator;
}

function fakePage(options: {
  url?: string;
  visible?: boolean;
  fieldValue?: string;
  readyState?: string;
} = {}): Page {
  const page = {
    url: () => options.url ?? `${origin}/`,
    getByText: () => fakeLocator({ visible: options.visible }),
    getByRole: () => fakeLocator({ visible: options.visible, value: options.fieldValue }),
    getByLabel: () => fakeLocator({ visible: options.visible, value: options.fieldValue }),
    getByTestId: () => fakeLocator({ visible: options.visible, value: options.fieldValue }),
    evaluate: async () => options.readyState ?? 'complete',
  };
  return page as unknown as Page;
}

const context = (overrides: Partial<VerificationContext> = {}): VerificationContext => ({
  allowedOrigin: origin,
  taskId,
  evidenceDir: '/tmp',
  timeoutMs: 10,
  fileExists: () => false,
  fileSize: () => 0,
  ...overrides,
});

const tempDir = path.resolve(process.cwd(), 'scratch_verify_evidence');

afterEach(() => {
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('@ghost/engine independent DOM verification', () => {
  it('verifies navigation origin and load state', async () => {
    const result = await verifyAction(
      fakePage({ url: `${origin}/` }),
      { type: 'NAVIGATE', payload: { url: `${origin}/` } },
      { kind: 'visibleText', value: 'GHOST Demo Application' },
      context()
    );
    expect(result.outcome).toBe('passed');
    expect(result.method).toContain('visible-text');
  });

  it('fails navigation that ends outside the approved origin', async () => {
    const result = await verifyAction(
      fakePage({ url: 'https://evil.example/' }),
      { type: 'NAVIGATE', payload: { url: `${origin}/` } },
      { kind: 'visibleText', value: 'GHOST' },
      context()
    );
    expect(result.outcome).toBe('failed');
    expect(result.method).toBe('navigation-origin');
  });

  it('verifies form-fill values without leaking them in the result', async () => {
    const secret = 'demo@example.com';
    const passed = await verifyAction(
      fakePage({ fieldValue: secret }),
      {
        type: 'FILL',
        payload: { locator: { by: 'label', label: 'Email' }, value: secret },
      },
      { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
      context()
    );
    expect(passed.outcome).toBe('passed');
    expect(passed.detail).not.toContain(secret);

    const failed = await verifyAction(
      fakePage({ fieldValue: 'different' }),
      {
        type: 'FILL',
        payload: { locator: { by: 'label', label: 'Email' }, value: secret },
      },
      { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
      context()
    );
    expect(failed.outcome).toBe('failed');
    expect(failed.detail).not.toContain(secret);
    expect(failed.detail).not.toContain('different');
  });

  it('does not treat a resolved click as proof without an observable postcondition', async () => {
    const passed = await verifyAction(
      fakePage({ visible: true }),
      {
        type: 'CLICK',
        payload: { locator: { by: 'role', role: 'button', name: 'Sign in' } },
      },
      { kind: 'visibleText', value: 'Welcome back, demo user' },
      context()
    );
    expect(passed.outcome).toBe('passed');
    expect(passed.method).toContain('click');

    const failed = await verifyAction(
      fakePage({ visible: false }),
      {
        type: 'CLICK',
        payload: { locator: { by: 'role', role: 'button', name: 'Sign in' } },
      },
      { kind: 'visibleText', value: 'Welcome back, demo user' },
      context()
    );
    expect(failed.outcome).toBe('failed');

    const inconclusive = await verifyAction(
      fakePage(),
      {
        type: 'CLICK',
        payload: { locator: { by: 'role', role: 'button', name: 'Sign in' } },
      },
      { kind: 'fieldValue', locator: { by: 'label', label: 'Email' } },
      context()
    );
    expect(inconclusive.outcome).toBe('inconclusive');
  });

  it('does not credit a click when its postcondition was already true', async () => {
    const result = await verifyAction(
      fakePage({ visible: true }),
      {
        type: 'CLICK',
        payload: { locator: { by: 'role', role: 'button', name: 'Show message' } },
      },
      { kind: 'visibleText', value: 'Message displayed' },
      context({ preexistingCondition: true })
    );
    expect(result.outcome).toBe('inconclusive');
    expect(result.detail).toContain('already true before the click');
  });

  it('verifies screenshot evidence exists, is non-empty, and belongs to the task', async () => {
    fs.mkdirSync(tempDir, { recursive: true });
    const filename = `${taskId}-result-123.png`;
    fs.writeFileSync(path.join(tempDir, filename), Buffer.from('png-bytes'));

    const passed = await verifyAction(
      fakePage(),
      { type: 'SCREENSHOT', payload: { name: 'result' } },
      { kind: 'screenshot' },
      context({
        evidenceFilename: filename,
        fileExists: (name) => fs.existsSync(path.join(tempDir, name)),
        fileSize: (name) => fs.statSync(path.join(tempDir, name)).size,
      })
    );
    expect(passed.outcome).toBe('passed');
    expect(passed.evidenceRef).toBe(filename);
    expect(passed.evidenceRef).toContain(taskId);

    const missing = await verifyAction(
      fakePage(),
      { type: 'SCREENSHOT', payload: { name: 'result' } },
      { kind: 'screenshot' },
      context({
        evidenceFilename: 'missing.png',
        fileExists: () => false,
      })
    );
    expect(missing.outcome).toBe('failed');
  });
});
