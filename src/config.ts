import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SmartMemoryConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * Load config. Priority (highest wins):
 *   1. Explicit overrides (from plugin registration)
 *   2. DEFAULT_CONFIG
 *
 * LLM calls are routed through OpenClaw's runtime — no API keys needed
 * except MEM0_API_KEY (optional, from environment) for Mem0 extraction.
 */
export function loadConfig(overrides?: Partial<SmartMemoryConfig>): SmartMemoryConfig {
  const config: SmartMemoryConfig = {
    ...DEFAULT_CONFIG,
    dataDir: join(homedir(), '.openclaw', 'smart-memory'),
    ...overrides,
  };

  // Mem0 API key from environment (only needed if using Mem0 extraction)
  config.mem0ApiKey = process.env.MEM0_API_KEY ?? '';

  return config;
}
