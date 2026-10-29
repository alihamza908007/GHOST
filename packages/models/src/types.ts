import type {
  VisualCondition,
  VisualObservation,
  VisualObservationInput,
} from '@ghost/core';

export type ModelErrorCode =
  | 'CONNECTION_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'GENERATION_FAILED'
  | 'MALFORMED_OUTPUT'
  | 'UNSUPPORTED_IMAGE_INPUT'
  | 'INVALID_REQUEST'
  | 'RESPONSE_TOO_LARGE';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;

  constructor(code: ModelErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isModelError(error: unknown): error is ModelError {
  return error instanceof ModelError;
}

export interface ModelProviderCapabilities {
  provider: string;
  baseUrl: string;
  model: string;
  connected: boolean;
  modelAvailable: boolean;
  version?: string;
  textGeneration: boolean;
  structuredOutput: boolean;
  vision: boolean;
  checkedAt: number;
  degradedFeatures: string[];
}

export interface ProviderProbeOptions {
  /** Exercise a tiny text generation request in addition to the metadata check. */
  testGeneration?: boolean;
  /** Require image-capable metadata; throws UNSUPPORTED_IMAGE_INPUT otherwise. */
  requireVision?: boolean;
  signal?: AbortSignal;
}

export interface StructuredGenerationRequest {
  requestId: string;
  system: string;
  user: string;
  /** JSON schema passed to Ollama's native structured-output `format` field. */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredGenerationResult {
  json: unknown;
  rawText: string;
  model: string;
  latencyMs: number;
}

export interface VisionGenerationRequest {
  requestId: string;
  system: string;
  user: string;
  /** Base64-encoded image bytes (PNG/JPEG) sent through Ollama's `images` field. */
  imageBase64: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface VisionGenerationResult {
  text: string;
  model: string;
  latencyMs: number;
}

/**
 * Vendor-neutral surface used by the planner and the server. The browser
 * engine never imports this package, so execution does not depend on Ollama.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly baseUrl: string;

  probe(options?: ProviderProbeOptions): Promise<ModelProviderCapabilities>;
  generateStructured(
    request: StructuredGenerationRequest
  ): Promise<StructuredGenerationResult>;
  generateVision?(request: VisionGenerationRequest): Promise<VisionGenerationResult>;
  cancel(requestId: string): void;
  cancelAll(): void;
}

/**
 * Local visual perception boundary. Implementations must keep model output
 * untrusted and must never be used as authorization for execution.
 */
export interface IVisualObserver {
  readonly name: string;
  readonly model: string;
  observe(input: VisualObservationInput): Promise<VisualObservation>;
  probe(options?: ProviderProbeOptions): Promise<ModelProviderCapabilities>;
}
