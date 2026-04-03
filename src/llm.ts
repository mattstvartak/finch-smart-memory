import type { SmartMemoryConfig } from './types.js';

/**
 * Thin OpenRouter client for cheap LLM calls (extraction, classification)
 * and embedding generation.
 */

export async function llmComplete(
  config: SmartMemoryConfig,
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openRouterApiKey}`,
    },
    body: JSON.stringify({
      model: config.cheapModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: opts?.maxTokens ?? 1000,
      temperature: opts?.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter chat error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

export async function embed(
  config: SmartMemoryConfig,
  text: string
): Promise<number[]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openRouterApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter embedding error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  return data.data?.[0]?.embedding ?? [];
}
