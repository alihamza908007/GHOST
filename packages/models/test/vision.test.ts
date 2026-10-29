import { describe, expect, it } from 'vitest';
import {
  isVisualObservation,
  ModelError,
  ModelProvider,
  OllamaVisionObserver,
} from '../src/index.js';
import { buildVisionPrompt } from '../src/prompt.js';

function fakeProvider(
  overrides: { generateVision?: ModelProvider['generateVision'] } = {}
): ModelProvider {
  return {
    name: 'fake-ollama',
    model: 'lfm3-omni:2b',
    baseUrl: 'http://127.0.0.1:11434',
    probe: async () => ({
      provider: 'fake-ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'lfm3-omni:2b',
      connected: true,
      modelAvailable: true,
      textGeneration: true,
      structuredOutput: true,
      vision: true,
      checkedAt: Date.now(),
      degradedFeatures: [],
    }),
    generateStructured: async () => ({ json: {}, rawText: '{}', model: 'lfm3-omni:2b', latencyMs: 1 }),
    ...(overrides.generateVision ? { generateVision: overrides.generateVision } : {}),
    cancel: () => undefined,
    cancelAll: () => undefined,
  };
}

const base64Png = Buffer.from('fake-png-bytes').toString('base64');

describe('@ghost/models visual observer', () => {
  it('accepts a strictly validated JSON vision observation', async () => {
    const observer = new OllamaVisionObserver(fakeProvider({
      generateVision: async () => ({
        text: JSON.stringify({
          summary: 'A success banner is visible',
          expectedCondition: 'present',
          obstructions: [],
          explanation: 'The success text appeared after the click.',
          confidence: 0.8,
        }),
        model: 'lfm3-omni:2b',
        latencyMs: 12,
      }),
    }));

    const observation = await observer.observe({
      taskId: 'task-vision-1',
      screenshotBase64: base64Png,
      expectedCondition: 'present',
      actionContext: 'CLICK Sign in (deterministic=failed)',
    });

    expect(observation.expectedCondition).toBe('present');
    expect(observation.summary).toBe('A success banner is visible');
    expect(observation.confidence).toBe(0.8);
    expect(observation.obstructions).toEqual([]);
  });

  it('rejects malformed JSON vision output as a retryable model error', async () => {
    const observer = new OllamaVisionObserver(fakeProvider({
      generateVision: async () => ({ text: 'the banner is happy', model: 'lfm3-omni:2b', latencyMs: 5 }),
    }));

    await expect(
      observer.observe({
        taskId: 'task-vision-2',
        screenshotBase64: base64Png,
        expectedCondition: 'present',
        actionContext: 'CLICK Sign in',
      })
    ).rejects.toMatchObject({ code: 'MALFORMED_OUTPUT' });
  });

  it('rejects vision output with extra or missing fields', async () => {
    const observer = new OllamaVisionObserver(fakeProvider({
      generateVision: async () => ({
        text: JSON.stringify({
          summary: 'Unexpected extra field',
          expectedCondition: 'present',
          obstructions: [],
          explanation: 'ok',
          confidence: 0.5,
          extra: true,
        }),
        model: 'lfm3-omni:2b',
        latencyMs: 5,
      }),
    }));

    await expect(
      observer.observe({
        taskId: 'task-vision-3',
        screenshotBase64: base64Png,
        expectedCondition: 'present',
        actionContext: 'CLICK Sign in',
      })
    ).rejects.toMatchObject({ code: 'MALFORMED_OUTPUT' });
  });

  it('returns a non-success diagnostic when the provider has no vision capability', async () => {
    const observer = new OllamaVisionObserver(fakeProvider({ generateVision: undefined }));
    await expect(
      observer.observe({
        taskId: 'task-vision-4',
        screenshotBase64: base64Png,
        expectedCondition: 'present',
        actionContext: 'CLICK Sign in',
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_INPUT' });
  });

  it('propagates timeout and invalid-request model errors', async () => {
    const timeoutObserver = new OllamaVisionObserver(fakeProvider({
      generateVision: async () => {
        throw new ModelError('TIMEOUT', 'The vision request timed out', true);
      },
    }));
    await expect(
      timeoutObserver.observe({
        taskId: 'task-vision-5',
        screenshotBase64: base64Png,
        expectedCondition: 'present',
        actionContext: 'CLICK Sign in',
      })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    const invalidObserver = new OllamaVisionObserver(fakeProvider({
      generateVision: async () => {
        throw new ModelError('INVALID_REQUEST', 'Screenshot exceeds the vision limit');
      },
    }));
    await expect(
      invalidObserver.observe({
        taskId: 'task-vision-6',
        screenshotBase64: base64Png,
        expectedCondition: 'present',
        actionContext: 'CLICK Sign in',
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('exposes a bounded vision prompt that treats image data as untrusted', () => {
    const prompt = buildVisionPrompt({
      expectedCondition: 'absent',
      actionContext: 'SCREENSHOT result',
      domObservations: ['Expected success text was missing'],
    });
    expect(prompt.system).toContain('never authorize');
    expect(prompt.user).toContain('Expected condition: absent');
    expect(prompt.user).toContain('deterministic_context');
  });

  it('validates observations through the shared strict schema', () => {
    expect(
      isVisualObservation({
        summary: 'ok',
        expectedCondition: 'uncertain',
        obstructions: [],
        explanation: 'not enough information',
      })
    ).toBe(true);
    expect(
      isVisualObservation({
        summary: '',
        expectedCondition: 'present',
        obstructions: [],
        explanation: 'ok',
      })
    ).toBe(false);
  });
});
