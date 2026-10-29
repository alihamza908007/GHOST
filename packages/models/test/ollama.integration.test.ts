import { describe, expect, it } from 'vitest';
import { ActionPolicy } from '@ghost/core';
import { OllamaProvider, StructuredPlanner } from '../src/index.js';

const model = process.env.OLLAMA_PLANNER_MODEL ?? 'gpt-oss:20b';
const origin = process.env.GHOST_DEMO_ORIGIN ?? 'http://127.0.0.1:3001';
const enabled = process.env.GHOST_RUN_OLLAMA_INTEGRATION === '1';

/**
 * Explicit local-model integration test. Skipped by default so ordinary CI
 * never depends on a loaded 13 GB model.
 */
describe.skipIf(!enabled)('local Ollama integration (opt-in)', () => {
  it(
    'probes gpt-oss structured output and produces a policy-valid plan',
    async () => {
      const provider = new OllamaProvider({
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
        model,
        timeoutMs: 90_000,
      });

      const capabilities = await provider.probe({ testGeneration: true });
      expect(capabilities.connected).toBe(true);
      expect(capabilities.modelAvailable).toBe(true);
      expect(capabilities.textGeneration).toBe(true);
      expect(capabilities.structuredOutput).toBe(true);
      expect(capabilities.vision).toBe(false);

      const planner = new StructuredPlanner(provider, {
        policy: new ActionPolicy({ allowedOrigin: origin }),
      });
      const result = await planner.plan(
        {
          objective:
            'Open the GHOST demo application, fill the Email field with demo@example.com, and click Sign in.',
        },
        { requestId: 'integration-plan' }
      );

      expect(result.plan.steps.length).toBeGreaterThan(0);
      expect(result.plan.steps.length).toBeLessThanOrEqual(8);
      expect(result.plan.steps[0].action.type).toBe('NAVIGATE');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    },
    120_000
  );
});
