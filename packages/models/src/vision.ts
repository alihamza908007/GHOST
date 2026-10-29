import { z } from 'zod';
import {
  LIMITS,
  VisualCondition,
  VisualObservation,
  VisualObservationInput,
} from '@ghost/core';
import {
  IVisualObserver,
  ModelError,
  ModelProvider,
  ModelProviderCapabilities,
  ProviderProbeOptions,
  VisionGenerationRequest,
  VisionGenerationResult,
} from './types.js';
import { buildVisionPrompt } from './prompt.js';

export const VisualObservationSchema = z
  .strictObject({
    summary: z.string().trim().min(1).max(300),
    expectedCondition: z.enum(['present', 'absent', 'uncertain']),
    obstructions: z.array(z.string().trim().min(1).max(200)).max(5),
    explanation: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
  });

export function isVisualObservation(value: unknown): value is VisualObservation {
  return VisualObservationSchema.safeParse(value).success;
}

function cleanBounded(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxChars) {
    throw new ModelError('RESPONSE_TOO_LARGE', 'Vision observation exceeded the text limit');
  }
  return cleaned;
}

/**
 * Local visual perception observer. It is intentionally separate from the text
 * planner and from the browser executor. Its output is untrusted evidence and is
 * never used as authorization for execution.
 */
export class OllamaVisionObserver implements IVisualObserver {
  readonly name = 'ollama-vision';
  readonly model: string;

  constructor(
    private readonly provider: ModelProvider,
    private readonly timeoutMs: number = 60_000,
    private readonly maxOutputTokens: number = 256
  ) {
    this.model = provider.model;
  }

  async observe(input: VisualObservationInput): Promise<VisualObservation> {
    const prompt = buildVisionPrompt({
      expectedCondition: input.expectedCondition,
      actionContext: input.actionContext,
      domObservations: input.domObservations,
    });

    const generateVision = this.provider.generateVision;
    if (!generateVision) {
      throw new ModelError('UNSUPPORTED_IMAGE_INPUT', 'The configured vision provider cannot process images');
    }

    const result: VisionGenerationResult = await generateVision({
      requestId: `vision-${input.taskId}-${Date.now()}`,
      system: prompt.system,
      user: prompt.user,
      imageBase64: input.screenshotBase64 ?? '',
      maxOutputTokens: this.maxOutputTokens,
      signal: undefined,
    });

    const raw = result.text.trim();
    if (raw.length > LIMITS.MAX_RATIONALE_CHARS) {
      throw new ModelError('RESPONSE_TOO_LARGE', 'Vision observation exceeded the response limit');
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new ModelError('MALFORMED_OUTPUT', 'The vision response was not valid JSON', true);
    }

    const parsed = VisualObservationSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ModelError('MALFORMED_OUTPUT', 'The vision response failed schema validation', true);
    }

    const observation: VisualObservation = {
      summary: cleanBounded(parsed.data.summary, LIMITS.MAX_SUMMARY_CHARS),
      expectedCondition: parsed.data.expectedCondition,
      obstructions: parsed.data.obstructions
        .map((item) => cleanBounded(item, LIMITS.MAX_LOCATOR_VALUE_CHARS))
        .filter((item) => item.length > 0)
        .slice(0, 5),
      explanation: cleanBounded(parsed.data.explanation, LIMITS.MAX_RATIONALE_CHARS),
    };
    if (parsed.data.confidence !== undefined) {
      observation.confidence = parsed.data.confidence;
    }

    return observation;
  }

  async probe(options: ProviderProbeOptions = {}): Promise<ModelProviderCapabilities> {
    const caps = await this.provider.probe({
      ...options,
      requireVision: true,
    });
    return {
      provider: this.name,
      baseUrl: this.provider.baseUrl,
      model: this.model,
      connected: caps.connected,
      modelAvailable: caps.modelAvailable,
      version: caps.version,
      textGeneration: caps.textGeneration,
      structuredOutput: caps.structuredOutput,
      vision: caps.vision,
      checkedAt: caps.checkedAt,
      degradedFeatures: caps.degradedFeatures,
    };
  }
}
