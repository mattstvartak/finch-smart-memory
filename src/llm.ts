import type { SmartMemoryConfig } from './types.js';

/**
 * LLM provider abstraction.
 *
 * The OpenClaw plugin entry injects the host runtime so all LLM calls
 * route through the user's already-configured provider. No separate
 * API key is needed.
 */

export interface LlmProvider {
  complete(systemPrompt: string, userMessage: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
  embed(text: string): Promise<number[]>;
}

let _provider: LlmProvider | null = null;

/**
 * Inject the LLM provider (called by plugin.ts at registration time).
 */
export function setLlmProvider(provider: LlmProvider): void {
  _provider = provider;
}

export async function llmComplete(
  _config: SmartMemoryConfig,
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  if (!_provider) throw new Error('LLM provider not initialized. The plugin must be loaded by OpenClaw.');
  return _provider.complete(systemPrompt, userMessage, opts);
}

export async function embed(
  _config: SmartMemoryConfig,
  text: string
): Promise<number[]> {
  if (!_provider) throw new Error('Embedding provider not initialized. The plugin must be loaded by OpenClaw.');
  return _provider.embed(text);
}
