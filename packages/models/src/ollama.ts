import {
  ModelError,
  ModelProvider,
  ModelProviderCapabilities,
  ProviderProbeOptions,
  StructuredGenerationRequest,
  StructuredGenerationResult,
  VisionGenerationRequest,
  VisionGenerationResult,
} from './types.js';

export interface OllamaProviderConfig {
  baseUrl?: string;
  model: string;
  /** Planning request timeout. */
  timeoutMs?: number;
  /** Metadata / generation probe timeout. */
  probeTimeoutMs?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
  maxPromptChars?: number;
  fetchImpl?: typeof fetch;
  /** Maximum accepted base64 image size for vision requests. */
  maxImageBytes?: number;
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434',
  timeoutMs: 45_000,
  probeTimeoutMs: 5_000,
  maxOutputTokens: 2_048,
  maxResponseBytes: 256 * 1024,
  maxPromptChars: 24_000,
  maxImageBytes: 8 * 1024 * 1024,
};

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function safeErrorText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Keep only a short, single-line message. Never echo prompts.
  return value.replace(/\s+/g, ' ').slice(0, 240);
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxResponseBytes: number;
  private readonly maxPromptChars: number;
  private readonly maxImageBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly active = new Map<string, AbortController>();

  constructor(config: OllamaProviderConfig) {
    const rawBaseUrl = (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      throw new ModelError('INVALID_REQUEST', 'OLLAMA_BASE_URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ModelError('INVALID_REQUEST', 'OLLAMA_BASE_URL must use http or https');
    }
    if (!isLoopbackHost(parsed.hostname)) {
      throw new ModelError(
        'INVALID_REQUEST',
        'OLLAMA_BASE_URL must point to a loopback address; remote inference is not permitted'
      );
    }

    this.baseUrl = parsed.toString().replace(/\/+$/, '');
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.probeTimeoutMs = config.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs;
    this.maxOutputTokens = Math.min(
      config.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
      2_048
    );
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    this.maxPromptChars = config.maxPromptChars ?? DEFAULTS.maxPromptChars;
    this.maxImageBytes = config.maxImageBytes ?? DEFAULTS.maxImageBytes;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  cancel(requestId: string): void {
    const controller = this.active.get(requestId);
    if (controller) {
      controller.abort('cancelled');
    }
  }

  cancelAll(): void {
    for (const controller of this.active.values()) {
      controller.abort('cancelled');
    }
    this.active.clear();
  }

  async probe(options: ProviderProbeOptions = {}): Promise<ModelProviderCapabilities> {
    const checkedAt = Date.now();
    let version: string | undefined;

    try {
      const versionBody = await this.runWithTimeout(
        `probe-version-${checkedAt}`,
        options.signal,
        this.probeTimeoutMs,
        (signal) => this.getJson('/api/version', signal)
      );
      version = typeof versionBody?.version === 'string' ? versionBody.version : undefined;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError('CONNECTION_FAILED', 'Unable to connect to the local Ollama server');
    }

    const tagsBody = await this.runWithTimeout(
      `probe-tags-${checkedAt}`,
      options.signal,
      this.probeTimeoutMs,
      (signal) => this.getJson('/api/tags', signal)
    );

    const models: any[] = Array.isArray(tagsBody?.models) ? tagsBody.models : [];
    const entry = models.find((item) => item?.name === this.model || item?.model === this.model);
    if (!entry) {
      throw new ModelError(
        'MODEL_NOT_FOUND',
        `Local Ollama model "${this.model}" is not installed. Start Ollama and install the configured model; GHOST will not download it automatically.`
      );
    }

    const capabilities: string[] = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    const textGeneration = capabilities.includes('completion') || capabilities.length === 0;
    const vision = capabilities.includes('vision');
    const degradedFeatures: string[] = [];
    if (!vision) degradedFeatures.push('vision_not_available');

    if (options.requireVision && !vision) {
      throw new ModelError(
        'UNSUPPORTED_IMAGE_INPUT',
        `Model "${this.model}" does not advertise image input capability`
      );
    }

    if (!textGeneration) {
      throw new ModelError(
        'GENERATION_FAILED',
        `Model "${this.model}" does not advertise text generation capability`
      );
    }

    if (options.testGeneration) {
      // Probe actual structured output rather than trusting model metadata.
      const probe = await this.generateStructured({
        requestId: `probe-structured-${checkedAt}`,
        system: 'You are a capability probe. Return the requested JSON object only.',
        user: 'Return {"ok": true}.',
        jsonSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        maxOutputTokens: 128,
        signal: options.signal,
      });
      if (
        typeof probe.json !== 'object' ||
        probe.json === null ||
        (probe.json as { ok?: unknown }).ok !== true
      ) {
        throw new ModelError(
          'GENERATION_FAILED',
          'The model responded, but structured output did not match the probe schema'
        );
      }
    }

    return {
      provider: this.name,
      baseUrl: this.baseUrl,
      model: this.model,
      connected: true,
      modelAvailable: true,
      version,
      textGeneration,
      structuredOutput: textGeneration,
      vision,
      checkedAt,
      degradedFeatures,
    };
  }

  async generateStructured(
    request: StructuredGenerationRequest
  ): Promise<StructuredGenerationResult> {
    const prompt = `${request.system}\n\n${request.user}`;
    if (prompt.length > this.maxPromptChars) {
      throw new ModelError(
        'INVALID_REQUEST',
        `Planning context exceeds the ${this.maxPromptChars}-character input limit`
      );
    }
    if (!request.jsonSchema || typeof request.jsonSchema !== 'object') {
      throw new ModelError('INVALID_REQUEST', 'A JSON schema is required for structured output');
    }

    const maxOutputTokens = Math.min(
      request.maxOutputTokens ?? this.maxOutputTokens,
      this.maxOutputTokens
    );
    const startedAt = Date.now();

    const body = await this.runWithTimeout(
      request.requestId,
      request.signal,
      this.timeoutMs,
      (signal) =>
        this.postJson(
          '/api/chat',
          {
            model: this.model,
            stream: false,
            // Ask for the lowest reasoning effort. gpt-oss ignores
            // `think: false`, and long hidden reasoning can consume the whole
            // output budget. `thinking` is always discarded; only JSON
            // `content` is parsed and Zod-validated.
            think: 'low',
            format: request.jsonSchema,
            options: {
              temperature: 0,
              num_predict: maxOutputTokens,
              num_ctx: 8_192,
            },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          },
          signal
        )
    );

    if (!body || typeof body !== 'object') {
      throw new ModelError('GENERATION_FAILED', 'Ollama returned an invalid chat response');
    }
    if (body.error) {
      const message = safeErrorText(body.error);
      if (/not found|unknown model|no such model/i.test(message)) {
        throw new ModelError('MODEL_NOT_FOUND', `Local model "${this.model}" is unavailable`);
      }
      throw new ModelError('GENERATION_FAILED', message || 'Ollama returned a generation error');
    }

    // `thinking` is intentionally ignored and never logged or persisted.
    const content = body?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ModelError(
        'MALFORMED_OUTPUT',
        'The model returned an empty response',
        true
      );
    }
    if (content.length > this.maxResponseBytes) {
      throw new ModelError('RESPONSE_TOO_LARGE', 'The model response exceeded the output limit');
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new ModelError(
        'MALFORMED_OUTPUT',
        'The model response was not valid JSON',
        true
      );
    }

    return {
      json,
      rawText: content,
      model: typeof body.model === 'string' ? body.model : this.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  async generateVision(request: VisionGenerationRequest): Promise<VisionGenerationResult> {
    const imageBytes = this.decodeBase64Image(request.imageBase64);
    const maxOutputTokens = Math.min(request.maxOutputTokens ?? 512, 1_024);
    const startedAt = Date.now();

    const body = await this.runWithTimeout(
      request.requestId,
      request.signal,
      this.timeoutMs,
      async (signal) =>
        this.postJson(
          '/api/chat',
          {
            model: this.model,
            stream: false,
            options: {
              temperature: 0,
              num_predict: maxOutputTokens,
              num_ctx: 8_192,
            },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user, images: [request.imageBase64] },
            ],
          },
          signal
        )
    );
    if (!body || typeof body !== 'object') {
      throw new ModelError('GENERATION_FAILED', 'Ollama returned an invalid vision response');
    }
    if (body.error) {
      const message = safeErrorText(body.error);
      if (/not found|unknown model|no such model|unsupported/i.test(message)) {
        throw new ModelError('UNSUPPORTED_IMAGE_INPUT', message || 'The vision model cannot process images');
      }
      throw new ModelError('GENERATION_FAILED', message || 'Ollama vision returned a generation error');
    }

    const content = body?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ModelError(
        'MALFORMED_OUTPUT',
        'The vision model returned an empty response',
        true
      );
    }
    if (content.length > this.maxResponseBytes) {
      throw new ModelError('RESPONSE_TOO_LARGE', 'The vision response exceeded the output limit');
    }

    return {
      text: content,
      model: typeof body.model === 'string' ? body.model : this.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  private decodeBase64Image(imageBase64: string): Uint8Array {
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      throw new ModelError('INVALID_REQUEST', 'A base64 image is required for vision requests');
    }
    const byteLength = Math.floor((imageBase64.length * 3) / 4);
    if (byteLength > this.maxImageBytes) {
      throw new ModelError(
        'INVALID_REQUEST',
        `Screenshot exceeds the ${this.maxImageBytes}-byte vision limit`
      );
    }
    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length === 0 || bytes.length > this.maxImageBytes) {
      throw new ModelError(
        'INVALID_REQUEST',
        `Screenshot image data is invalid or exceeds the ${this.maxImageBytes}-byte vision limit`
      );
    }
    return new Uint8Array(bytes);
  }

  private async getJson(path: string, signal: AbortSignal): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      signal,
      headers: { accept: 'application/json' },
    });
    return this.readResponse(response, 'GET');
  }

  private async postJson(path: string, payload: unknown, signal: AbortSignal): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    return this.readResponse(response, 'POST');
  }

  private async readResponse(response: Response, method: string): Promise<any> {
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > this.maxResponseBytes) {
      throw new ModelError('RESPONSE_TOO_LARGE', 'Ollama response exceeded the size limit');
    }

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError('CONNECTION_FAILED', 'Unable to read the Ollama response');
    }

    if (text.length > this.maxResponseBytes) {
      throw new ModelError('RESPONSE_TOO_LARGE', 'Ollama response exceeded the size limit');
    }

    if (!response.ok) {
      let message = '';
      try {
        const parsed = JSON.parse(text);
        message = safeErrorText(parsed?.error ?? parsed?.message ?? '');
      } catch {
        message = safeErrorText(text);
      }
      if (response.status === 404 || /model.*not found/i.test(message)) {
        throw new ModelError('MODEL_NOT_FOUND', `Local model "${this.model}" is unavailable`);
      }
      throw new ModelError(
        'GENERATION_FAILED',
        `Ollama ${method} ${response.status}: ${message || 'request failed'}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError('MALFORMED_OUTPUT', 'Ollama returned a malformed response envelope');
    }
  }

  private async runWithTimeout<T>(
    requestId: string,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.active.has(requestId)) {
      throw new ModelError('INVALID_REQUEST', 'A request with this id is already in progress');
    }

    const controller = new AbortController();
    this.active.set(requestId, controller);
    let timedOut = false;
    let externallyCancelled = false;

    const onExternalAbort = () => {
      externallyCancelled = true;
      controller.abort('cancelled');
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        externallyCancelled = true;
        controller.abort('cancelled');
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, timeoutMs);

    try {
      return await fn(controller.signal);
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (externallyCancelled || controller.signal.reason === 'cancelled') {
        throw new ModelError('CANCELLED', 'The model request was cancelled');
      }
      if (timedOut || controller.signal.reason === 'timeout') {
        throw new ModelError(
          'TIMEOUT',
          `The local model did not respond within ${timeoutMs}ms`,
          true
        );
      }
      if (error instanceof TypeError) {
        throw new ModelError(
          'CONNECTION_FAILED',
          'Unable to connect to the local Ollama server at ' + this.baseUrl
        );
      }
      const message = error instanceof Error ? safeErrorText(error.message) : '';
      throw new ModelError(
        'GENERATION_FAILED',
        message || 'The local model request failed'
      );
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      if (this.active.get(requestId) === controller) {
        this.active.delete(requestId);
      }
    }
  }
}
