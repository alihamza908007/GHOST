import { describe, expect, it, vi } from 'vitest';
import { ModelError, OllamaProvider } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('@ghost/models OllamaProvider', () => {
  it('rejects remote base URLs', () => {
    expect(
      () =>
        new OllamaProvider({
          baseUrl: 'https://api.example.com',
          model: 'gpt-oss:20b',
        })
    ).toThrowError(ModelError);
  });

  it('normalizes connection failures', async () => {
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
    });
    await expect(provider.probe()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('distinguishes model-not-found from connection failure', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/api/version')) return jsonResponse({ version: '0.40.12' });
      if (path.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'other:1b', capabilities: ['completion'] }] });
      }
      throw new Error('unexpected');
    });
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.probe()).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('reports capabilities and vision absence truthfully', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/api/version')) return jsonResponse({ version: '0.40.12' });
      return jsonResponse({
        models: [{ name: 'gpt-oss:20b', capabilities: ['completion', 'tools', 'thinking'] }],
      });
    });
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.probe();
    expect(result).toMatchObject({
      connected: true,
      modelAvailable: true,
      textGeneration: true,
      vision: false,
      version: '0.40.12',
    });
    expect(result.degradedFeatures).toContain('vision_not_available');
  });

  it('throws a distinct unsupported-image error when vision is required', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/api/version')) return jsonResponse({ version: '1' });
      return jsonResponse({ models: [{ name: 'gpt-oss:20b', capabilities: ['completion'] }] });
    });
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.probe({ requireVision: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_IMAGE_INPUT',
    });
  });

  it('enforces request timeouts', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.generateStructured({
        requestId: 'timeout-test',
        system: 'system',
        user: 'user',
        jsonSchema: { type: 'object' },
      })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('supports cancellation with a distinct error code', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          setTimeout(() => controller.abort(), 10);
        })
    );
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.generateStructured({
        requestId: 'cancel-test',
        system: 'system',
        user: 'user',
        jsonSchema: { type: 'object' },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('normalizes malformed JSON and empty generations', async () => {
    const malformed = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ model: 'gpt-oss:20b', message: { content: 'not json' } })
      ) as unknown as typeof fetch,
    });
    await expect(
      malformed.generateStructured({
        requestId: 'malformed',
        system: 's',
        user: 'u',
        jsonSchema: { type: 'object' },
      })
    ).rejects.toMatchObject({ code: 'MALFORMED_OUTPUT', retryable: true });

    const empty = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ model: 'gpt-oss:20b', message: { content: '  ' } })
      ) as unknown as typeof fetch,
    });
    await expect(
      empty.generateStructured({
        requestId: 'empty',
        system: 's',
        user: 'u',
        jsonSchema: { type: 'object' },
      })
    ).rejects.toMatchObject({ code: 'MALFORMED_OUTPUT', retryable: true });
  });

  it('passes a native JSON schema to Ollama and ignores thinking output', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          model: 'gpt-oss:20b',
          message: { content: '{"ok":true}', thinking: 'private chain of thought' },
        })
    );
    const provider = new OllamaProvider({
      model: 'gpt-oss:20b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.generateStructured({
      requestId: 'schema',
      system: 's',
      user: 'u',
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(result.json).toEqual({ ok: true });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string
    );
    expect(body.format).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(body.stream).toBe(false);
    expect(body.think).toBe('low');
  });
});
