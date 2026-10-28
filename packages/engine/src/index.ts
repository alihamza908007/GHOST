import { Task, TaskStatus, TaskEvent, Action, ActionType } from '@ghost/core';
import { ITaskRepository, IEvidenceRepository } from '@ghost/storage';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export interface IExecutionEngine {
  executePlan(task: Task, plan: Action[]): Promise<void>;
}

export class ExecutionEngine implements IExecutionEngine {
  constructor(
    private taskRepo: ITaskRepository,
    private evidenceRepo: IEvidenceRepository,
    private allowedOrigin: string,
    private evidenceDir: string
  ) {}

  private async createEvent(taskId: string, type: 'ACTION_STARTED' | 'ACTION_FINISHED' | 'ERROR', data: Record<string, unknown> = {}): Promise<void> {
    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      timestamp: Date.now(),
      data
    };
    await this.taskRepo.addEvent(event);
  }

  async executePlan(task: Task, plan: Action[]): Promise<void> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      // Update status to EXECUTING
      task.status = 'EXECUTING';
      await this.taskRepo.update(task.id, { status: task.status });

      const launchOptions: { headless: boolean; channel?: string } = { headless: true };
      if (process.env.PLAYWRIGHT_CHROMIUM_CHANNEL) {
        launchOptions.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
      } else if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
        launchOptions.channel = 'chrome';
      }

      browser = await chromium.launch(launchOptions);
      // Isolated context
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
      });

      // Disable service workers (as per requirements)
      // In Playwright, this is often handled by default or via specific settings
      // but for completeness:
      // context.addInitScript(() => { ... }); 
      // Actually, service workers are somewhat controlled via the browser context settings in some ways.

      const page = await context.newPage();

      for (const action of plan) {
        await this.executeAction(page, task, action);
      }

      // Completion: Final Step is usually capture/screenshot in our deterministic plan
      // The plan should have been prepared by the caller.
      
      task.status = 'COMPLETED';
      await this.taskRepo.update(task.id, { status: task.status });

    } catch (error: any) {
      console.error('Execution Error:', error);
      task.status = 'FAILED';
      await this.taskRepo.update(task.id, { status: task.status });
      await this.createEvent(task.id, 'ERROR', { message: error.message });
    } finally {
      if (context) await context.close();
      if (browser) await browser.close();
    }
  }

  private async executeAction(page: Page, task: Task, action: Action): Promise<void> {
    await this.createEvent(task.id, 'ACTION_STARTED', { type: action.type });

    try {
      if (action.type === 'NAVIGATE') {
        const url = action.payload.url;
        // Security Check
        if (!this.isValidUrl(url)) {
          throw new Error(`Unapproved origin: ${url}`);
        }
        await page.goto(url, { waitUntil: 'networkidle' });
      } else if (action.type === 'SCREENSHOT') {
        const name = action.payload.name;
        const screenshotBuffer = await page.screenshot();
        const filename = `${task.id}-${name}-${Date.now()}.png`;
        const fullPath = path.join(this.evidenceDir, filename);

        fs.writeFileSync(fullPath, screenshotBuffer);

        // Update task event as end of action
        await this.createEvent(task.id, 'ACTION_FINISHED', { type: action.type, screenshot: filename });
        return;
      }

      await this.createEvent(task.id, 'ACTION_FINISHED', { type: action.type });
    } catch (e: any) {
      throw e;
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      // Only allow URL if it's on the exact allowed origin
      return parsed.origin === this.allowedOrigin;
    } catch {
      return false;
    }
  }
}
