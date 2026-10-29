import { Action, Expectation, Locator, VerificationResult, isAllowedUrl } from '@ghost/core';
import type { Locator as PlaywrightLocator, Page } from 'playwright';

export interface VerificationContext {
  allowedOrigin: string;
  taskId: string;
  evidenceDir: string;
  timeoutMs?: number;
  /** Actual stored screenshot name, when verifying a SCREENSHOT action. */
  evidenceFilename?: string;
  /**
   * True when the expectation already held before a CLICK. In that case a
   * post-click pass cannot prove the click caused the observed state.
   */
  preexistingCondition?: boolean;
  fileExists?: (filename: string) => boolean;
  fileSize?: (filename: string) => number;
}

export function resolveLocator(page: Page, locator: Locator): PlaywrightLocator {
  switch (locator.by) {
    case 'role':
      return page
        .getByRole(locator.role as Parameters<Page['getByRole']>[0], {
          name: locator.name,
          exact: false,
        })
        .first();
    case 'label':
      return page.getByLabel(locator.label, { exact: false }).first();
    case 'testId':
      return page.getByTestId(locator.testId).first();
    default:
      throw new Error('Unsupported locator');
  }
}

async function isVisible(locator: PlaywrightLocator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function checkExpectation(
  page: Page,
  expectation: Expectation,
  action: Action | null,
  context: VerificationContext
): Promise<VerificationResult | null> {
  const timeoutMs = context.timeoutMs ?? 2_500;
  const timestamp = Date.now();

  if (expectation.kind === 'url') {
    const current = page.url();
    if (!isAllowedUrl(current, context.allowedOrigin)) {
      return {
        outcome: 'failed',
        method: 'url-origin',
        detail: 'Final URL is outside the approved origin',
        expectationKind: expectation.kind,
        timestamp,
      };
    }
    const normalize = (value: string) => value.replace(/\/$/, '');
    const passed = normalize(current) === normalize(expectation.value);
    return {
      outcome: passed ? 'passed' : 'failed',
      method: 'url-match',
      detail: passed ? 'Final URL matched the expected URL' : 'Final URL did not match the expected URL',
      expectationKind: expectation.kind,
      timestamp,
    };
  }

  if (expectation.kind === 'visibleText') {
    const passed = await isVisible(
      page.getByText(expectation.value, { exact: false }).first(),
      timeoutMs
    );
    return {
      outcome: passed ? 'passed' : 'failed',
      method: 'dom-visible-text',
      detail: passed
        ? 'Expected visible text was found in the DOM'
        : 'Expected visible text was not found',
      expectationKind: expectation.kind,
      timestamp,
    };
  }

  if (expectation.kind === 'elementVisible') {
    const passed = await isVisible(resolveLocator(page, expectation.locator), timeoutMs);
    return {
      outcome: passed ? 'passed' : 'failed',
      method: 'dom-element-visible',
      detail: passed ? 'Expected element is visible' : 'Expected element is not visible',
      expectationKind: expectation.kind,
      timestamp,
    };
  }

  if (expectation.kind === 'fieldValue') {
    if (!action || action.type !== 'FILL') {
      return {
        outcome: 'inconclusive',
        method: 'dom-field-value',
        detail: 'A field-value expectation is only observable for FILL actions',
        expectationKind: expectation.kind,
        timestamp,
      };
    }
    try {
      const actual = await resolveLocator(page, expectation.locator).inputValue();
      const passed = actual === action.payload.value;
      return {
        outcome: passed ? 'passed' : 'failed',
        method: 'dom-field-value',
        detail: passed
          ? 'Field value matched the expected input (value redacted)'
          : 'Field value did not match the expected input (value redacted)',
        expectationKind: expectation.kind,
        timestamp,
      };
    } catch {
      return {
        outcome: 'failed',
        method: 'dom-field-value',
        detail: 'Target field could not be read for verification (value redacted)',
        expectationKind: expectation.kind,
        timestamp,
      };
    }
  }

  return null;
}

/**
 * Deterministic expectation evaluation used to capture pre-action state. It
 * uses the same semantic locators as post-action verification and never
 * evaluates model-generated JavaScript.
 */
export async function evaluateExpectation(
  page: Page,
  expectation: Expectation,
  context: VerificationContext
): Promise<VerificationResult | null> {
  return checkExpectation(page, expectation, null, context);
}

/**
 * Independent, deterministic verification. It never uses model output as
 * evidence and never evaluates model-generated JavaScript.
 */
export async function verifyAction(
  page: Page,
  action: Action,
  expectation: Expectation,
  context: VerificationContext
): Promise<VerificationResult> {
  const timestamp = Date.now();

  if (action.type === 'NAVIGATE') {
    if (!isAllowedUrl(page.url(), context.allowedOrigin)) {
      return {
        outcome: 'failed',
        method: 'navigation-origin',
        detail: 'Navigation ended outside the approved origin',
        timestamp,
      };
    }
    let readyState = 'unknown';
    try {
      readyState = await page.evaluate(() => document.readyState);
    } catch {
      return {
        outcome: 'failed',
        method: 'navigation-load-state',
        detail: 'Page load state could not be observed',
        timestamp,
      };
    }
    if (readyState !== 'complete' && readyState !== 'interactive') {
      return {
        outcome: 'inconclusive',
        method: 'navigation-load-state',
        detail: 'Page did not reach an acceptable load state',
        timestamp,
      };
    }
    const expected = await checkExpectation(page, expectation, action, context);
    if (expected) return expected;
    return {
      outcome: 'passed',
      method: 'navigation-origin+load-state',
      detail: 'Navigation stayed on the approved origin and the page loaded',
      expectationKind: expectation.kind,
      timestamp,
    };
  }

  if (action.type === 'FILL') {
    try {
      const actual = await resolveLocator(page, action.payload.locator).inputValue();
      if (actual !== action.payload.value) {
        return {
          outcome: 'failed',
          method: 'dom-field-value',
          detail: 'The field does not contain the expected value (value redacted)',
          expectationKind: expectation.kind,
          timestamp,
        };
      }
    } catch {
      return {
        outcome: 'failed',
        method: 'dom-field-value',
        detail: 'The target field could not be read (value redacted)',
        expectationKind: expectation.kind,
        timestamp,
      };
    }

    if (expectation.kind !== 'fieldValue') {
      const expected = await checkExpectation(page, expectation, action, context);
      if (expected) {
        return expected.outcome === 'passed'
          ? {
              ...expected,
              detail: 'Field value matched and postcondition was observed',
            }
          : expected;
      }
    }

    return {
      outcome: 'passed',
      method: 'dom-field-value',
      detail: 'Field value matched the expected input (value redacted)',
      expectationKind: expectation.kind,
      timestamp,
    };
  }

  if (action.type === 'CLICK') {
    const expected = await checkExpectation(page, expectation, action, context);
    if (!expected) {
      return {
        outcome: 'inconclusive',
        method: 'click-postcondition',
        detail: 'No observable postcondition was supplied for the click',
        timestamp,
      };
    }
    if (expected.outcome === 'passed' && context.preexistingCondition) {
      return {
        ...expected,
        outcome: 'inconclusive',
        method: `click+${expected.method}`,
        detail:
          'The expected postcondition was already true before the click, so it does not prove the click caused it',
      };
    }
    if (expected.outcome !== 'passed') {
      return {
        ...expected,
        detail: 'Click completed but the expected postcondition was not observed',
      };
    }
    return {
      ...expected,
      method: `click+${expected.method}`,
      detail: 'Click postcondition was independently observed in the DOM',
    };
  }

  if (action.type === 'SCREENSHOT') {
    const filename = context.evidenceFilename ?? `${context.taskId}-${action.payload.name}.png`;
    // The engine stores screenshots with a timestamp suffix; check the prefix
    // when the exact file is supplied by the caller.
    const exists = context.fileExists;
    const size = context.fileSize;
    if (!exists || !size) {
      return {
        outcome: 'inconclusive',
        method: 'evidence-file',
        detail: 'Evidence store is not available for verification',
        timestamp,
      };
    }
    const present = exists(filename);
    const bytes = present ? size(filename) : 0;
    return {
      outcome: present && bytes > 0 ? 'passed' : 'failed',
      method: 'evidence-file',
      detail:
        present && bytes > 0
          ? 'Screenshot evidence exists and is non-empty'
          : 'Screenshot evidence is missing or empty',
      expectationKind: 'screenshot',
      evidenceRef: present ? filename : undefined,
      timestamp,
    };
  }

  return {
    outcome: 'inconclusive',
    method: 'unsupported-action',
    detail: 'No deterministic verifier is registered for this action',
    timestamp,
  };
}
