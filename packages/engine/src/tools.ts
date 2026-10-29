import { Action, ActionType, resolveContainedEvidencePath } from '@ghost/core';
import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { PolicyViolationError } from './errors.js';
import { resolveLocator } from './verification.js';
import { redactScreenshot } from './redaction.js';

export interface BrowserToolContext {
  page: Page;
  taskId: string;
  evidenceDir: string;
  actionTimeoutMs: number;
  redactScreenshots?: boolean;
}

export interface BrowserToolResult {
  evidenceFilename?: string;
  evidenceSize?: number;
}

export type BrowserTool = (
  action: Action,
  context: BrowserToolContext
) => Promise<BrowserToolResult>;

/**
 * The only bridge between a validated action and Playwright. There is no
 * generic "run script" or arbitrary selector tool.
 */
export class BrowserToolRegistry {
  private readonly tools = new Map<ActionType, BrowserTool>();

  constructor() {
    this.tools.set('NAVIGATE', async (action, context) => {
      if (action.type !== 'NAVIGATE') return {};
      await context.page.goto(action.payload.url, {
        waitUntil: 'domcontentloaded',
        timeout: context.actionTimeoutMs,
      });
      await context.page.waitForLoadState('load', {
        timeout: context.actionTimeoutMs,
      });
      return {};
    });

    this.tools.set('CLICK', async (action, context) => {
      if (action.type !== 'CLICK') return {};
      await resolveLocator(context.page, action.payload.locator).click({
        timeout: context.actionTimeoutMs,
      });
      return this.captureScreenshot(action, context);
    });

    this.tools.set('FILL', async (action, context) => {
      if (action.type !== 'FILL') return {};
      await resolveLocator(context.page, action.payload.locator).fill(action.payload.value, {
        timeout: context.actionTimeoutMs,
      });
      return this.captureScreenshot(action, context);
    });

    this.tools.set('SCREENSHOT', async (action, context) => {
      if (action.type !== 'SCREENSHOT') return {};
      const rawBuffer = await context.page.screenshot({ fullPage: true });
      const buffer = await redactScreenshot(context.page, rawBuffer, context.redactScreenshots !== false);
      const filename = `${context.taskId}-${action.payload.name}-${Date.now()}.png`;
      const fullPath = resolveContainedEvidencePath(context.evidenceDir, filename);
      fs.writeFileSync(fullPath, buffer);
      return { evidenceFilename: filename, evidenceSize: buffer.byteLength };
    });
  }

  get(type: ActionType): BrowserTool {
    const tool = this.tools.get(type);
    if (!tool) {
      throw new PolicyViolationError('INVALID_ACTION', `No registered browser tool for ${type}`);
    }
    return tool;
  }

  private async captureScreenshot(action: Action, context: BrowserToolContext): Promise<BrowserToolResult> {
    // Post-action screenshots become the local vision observer's evidence.
    // They are always written under the task evidence root and never leave it.
    const rawBuffer = await context.page.screenshot({ fullPage: true });
    const buffer = await redactScreenshot(context.page, rawBuffer, context.redactScreenshots !== false);
    const filename = `${context.taskId}-${action.type.toLowerCase()}-${Date.now()}.png`;
    const fullPath = resolveContainedEvidencePath(context.evidenceDir, filename);
    fs.writeFileSync(fullPath, buffer);
    return { evidenceFilename: filename, evidenceSize: buffer.byteLength };
  }

  async execute(action: Action, context: BrowserToolContext): Promise<BrowserToolResult> {
    return this.get(action.type)(action, context);
  }
}
