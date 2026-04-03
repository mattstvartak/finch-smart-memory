import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SmartMemoryConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

function dataDir(): string {
  return process.env.SMART_MEMORY_DIR ?? join(homedir(), '.openclaw', 'smart-memory');
}

function configPath(): string {
  return join(dataDir(), 'config.json');
}

/**
 * Load config. Priority (highest wins):
 *   1. Explicit overrides
 *   2. Environment variables
 *   3. <dataDir>/config.json (non-secret settings only)
 *   4. DEFAULT_CONFIG
 *
 * API keys come ONLY from environment variables — never stored on disk.
 */
export function loadConfig(overrides?: Partial<SmartMemoryConfig>): SmartMemoryConfig {
  // Read non-secret settings from config.json
  let fileConfig: Partial<SmartMemoryConfig> = {};
  const cfgPath = configPath();
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      // Only load non-secret fields
      if (raw.mem0UserId) fileConfig.mem0UserId = raw.mem0UserId;
      if (raw.extractionProvider) fileConfig.extractionProvider = raw.extractionProvider;
      if (raw.cheapModel) fileConfig.cheapModel = raw.cheapModel;
      if (raw.embeddingModel) fileConfig.embeddingModel = raw.embeddingModel;
      if (raw.maxRecallChunks) fileConfig.maxRecallChunks = raw.maxRecallChunks;
      if (raw.maxRecallTokens) fileConfig.maxRecallTokens = raw.maxRecallTokens;
      if (raw.extractionThreshold) fileConfig.extractionThreshold = raw.extractionThreshold;
      if (raw.dailyRetentionDays) fileConfig.dailyRetentionDays = raw.dailyRetentionDays;
      if (raw.shortTermRetentionDays) fileConfig.shortTermRetentionDays = raw.shortTermRetentionDays;
      if (raw.longTermRetentionDays) fileConfig.longTermRetentionDays = raw.longTermRetentionDays;
    } catch { /* noop */ }
  }

  const config: SmartMemoryConfig = {
    ...DEFAULT_CONFIG,
    dataDir: dataDir(),
    ...fileConfig,
    ...overrides,
  };

  // API keys from environment variables only
  config.openRouterApiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_KEY ?? '';
  config.mem0ApiKey = process.env.MEM0_API_KEY ?? '';

  // Other env overrides
  if (process.env.MEM0_USER_ID) config.mem0UserId = process.env.MEM0_USER_ID;
  if (process.env.SMART_MEMORY_DIR) config.dataDir = process.env.SMART_MEMORY_DIR;
  if (process.env.SMART_MEMORY_CHEAP_MODEL) config.cheapModel = process.env.SMART_MEMORY_CHEAP_MODEL;
  if (process.env.SMART_MEMORY_EMBEDDING_MODEL) config.embeddingModel = process.env.SMART_MEMORY_EMBEDDING_MODEL;
  if (process.env.SMART_MEMORY_EXTRACTION_PROVIDER) config.extractionProvider = process.env.SMART_MEMORY_EXTRACTION_PROVIDER as any;

  return config;
}

/**
 * Read persisted config.json (non-secret settings).
 */
export function getPersistedConfig(): Record<string, any> {
  const cfgPath = configPath();
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Set a non-secret value in the skill's own config.json.
 */
export function setConfigValue(key: string, value: string | number): void {
  const cfgPath = configPath();
  const dir = dirname(cfgPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = getPersistedConfig();
  existing[key] = value;
  writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}
