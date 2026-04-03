// ── Memory Tiers ─────────────────────────────────────────────────────
// daily → short-term → long-term → archive
// Each tier has different retention and decay characteristics.

export type MemoryTier = 'daily' | 'short-term' | 'long-term' | 'archive';
export type MemoryType = 'fact' | 'preference' | 'decision' | 'context' | 'correction';
export type CognitiveLayer = 'episodic' | 'semantic' | 'procedural';
export type Sentiment = 'frustrated' | 'curious' | 'satisfied' | 'neutral' | 'excited' | 'confused';

// ── Memory Chunk ─────────────────────────────────────────────────────

export interface MemoryChunk {
  id: string;
  tier: MemoryTier;
  content: string;
  type: MemoryType;
  cognitiveLayer: CognitiveLayer;
  tags: string[];
  source: string; // conversation or session ID
  importance: number; // 0.0–1.0
  sentiment: Sentiment;
  createdAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  embedding?: number[];
}

// ── Memory Edges (Graph) ─────────────────────────────────────────────

export interface MemoryEdge {
  targetId: string;
  relationship: 'temporal' | 'semantic' | 'causal' | 'co-recalled';
  weight: number; // 0.0–1.0
  createdAt: string;
}

// ── Recall Outcomes ──────────────────────────────────────────────────

export interface RecallOutcome {
  conversationId: string;
  outcome: 'helpful' | 'corrected' | 'irrelevant';
  timestamp: string;
}

// ── Procedural Rules ─────────────────────────────────────────────────

export interface ProceduralRule {
  id: string;
  rule: string;
  domain: 'code' | 'communication' | 'workflow' | 'preference' | 'general';
  confidence: number; // 0.0–1.0
  reinforcements: number;
  contradictions: number;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Daily Logs ───────────────────────────────────────────────────────

export interface DailyLogEntry {
  timestamp: string;
  conversationId: string;
  summary: string;
  extractedFacts: string[];
}

// ── Search Results ───────────────────────────────────────────────────

export interface SearchResult {
  chunk: MemoryChunk;
  score: number;
}

// ── Config ───────────────────────────────────────────────────────────

export interface SmartMemoryConfig {
  /** Root data directory (default: ~/.openclaw/smart-memory) */
  dataDir: string;
  /** Cheap model for extraction/classification (default: google/gemini-2.5-flash-lite-preview) */
  cheapModel: string;
  /** Embedding model (default: google/text-embedding-004 via OpenRouter) */
  embeddingModel: string;
  /** Days before daily tier moves to short-term (default: 2) */
  dailyRetentionDays: number;
  /** Days before short-term promotes to long-term if recalled (default: 14) */
  shortTermRetentionDays: number;
  /** Days before long-term demotes to archive if stale (default: 90) */
  longTermRetentionDays: number;
  /** Max chunks to return per search (default: 10) */
  maxRecallChunks: number;
  /** Max tokens budget for recalled memories (default: 1500) */
  maxRecallTokens: number;
  /** Minimum messages before triggering extraction (default: 3) */
  extractionThreshold: number;
  /** Mem0 API key (optional — enables Mem0 cloud extraction) */
  mem0ApiKey: string;
  /** Mem0 user ID for scoping memories (default: 'default') */
  mem0UserId: string;
  /** Extraction provider: 'local' (OpenClaw runtime) or 'mem0' or 'both' (default: 'local') */
  extractionProvider: 'local' | 'mem0' | 'both';
}

export const DEFAULT_CONFIG: SmartMemoryConfig = {
  dataDir: '',
  cheapModel: 'google/gemini-2.5-flash-lite-preview',
  embeddingModel: 'google/text-embedding-004',
  dailyRetentionDays: 2,
  shortTermRetentionDays: 14,
  longTermRetentionDays: 90,
  maxRecallChunks: 10,
  maxRecallTokens: 1500,
  extractionThreshold: 3,
  mem0ApiKey: '',
  mem0UserId: 'default',
  extractionProvider: 'local',
};
