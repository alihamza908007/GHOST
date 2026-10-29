import { ModelError, OllamaProvider } from '../src/index.js';

async function main(): Promise<void> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_PLANNER_MODEL ?? 'gpt-oss:20b';
  const provider = new OllamaProvider({
    baseUrl,
    model,
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000),
    probeTimeoutMs: 5_000,
  });

  try {
    const tags = await fetch(`${baseUrl}/api/tags`).then((response) => response.json());
    const installed = Array.isArray((tags as { models?: unknown[] }).models)
      ? (tags as { models: Array<{ name: string; capabilities?: string[] }> }).models
      : [];

    console.log('Installed local Ollama models:');
    for (const entry of installed) {
      console.log(`- ${entry.name} [${(entry.capabilities ?? []).join(', ') || 'unknown'}]`);
    }

    const capabilities = await provider.probe({ testGeneration: true });
    console.log(
      JSON.stringify(
        {
          model: capabilities.model,
          ollamaVersion: capabilities.version,
          connected: capabilities.connected,
          modelAvailable: capabilities.modelAvailable,
          textGeneration: capabilities.textGeneration,
          structuredOutput: capabilities.structuredOutput,
          vision: capabilities.vision,
          degradedFeatures: capabilities.degradedFeatures,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (error instanceof ModelError) {
      console.error(`Probe failed: ${error.code}: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error('Probe failed safely');
    process.exitCode = 2;
  }
}

void main();
