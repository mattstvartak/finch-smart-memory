import type { SmartMemoryConfig, SearchResult } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { embed, llmComplete } from './llm.js';
import { cosineSimilarity, estimateTokens } from './utils.js';

/**
 * Hybrid memory search: native ANN vector search (LanceDB) + keyword + bonuses + spreading activation.
 *
 * Cost: 1 embedding call per search (~$0.00001 via OpenRouter).
 */
export async function search(
  config: SmartMemoryConfig,
  storage: Storage,
  query: string,
  maxResults?: number
): Promise<SearchResult[]> {
  const limit = maxResults ?? config.maxRecallChunks;
  const allChunks = await storage.listChunks({ excludeTiers: ['archive'] });
  if (allChunks.length === 0) return [];

  const scored = new Map<string, { chunk: StoredChunk; score: number }>();

  // ── Native ANN vector search via LanceDB ───────────────────────────
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(config, query);
  } catch {
    // Fall back to keyword-only
  }

  if (queryEmbedding) {
    const vectorResults = await storage.vectorSearch(
      queryEmbedding,
      Math.min(limit * 3, 30), // fetch extra candidates for re-ranking
      "tier != 'archive'"
    );

    for (const { chunk, distance } of vectorResults) {
      // Convert cosine distance (0=identical, 2=opposite) to similarity (1=identical, -1=opposite)
      const similarity = 1 - distance;
      if (similarity > 0.3) {
        scored.set(chunk.id, { chunk, score: similarity });
      }
    }
  }

  // ── Keyword scoring (word-boundary matching) ───────────────────────
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length > 0) {
    for (const chunk of allChunks) {
      const text = `${chunk.content} ${chunk.tags.join(' ')}`.toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`).test(text)) matchCount++;
      }

      if (matchCount > 0) {
        const keywordScore = matchCount / queryTerms.length;
        const existing = scored.get(chunk.id);
        if (existing) {
          // Hybrid blend: 70% vector + 30% keyword
          existing.score = existing.score * 0.7 + keywordScore * 0.3;
        } else {
          scored.set(chunk.id, { chunk, score: keywordScore * 0.5 });
        }
      }
    }
  }

  // ── Bonus factors ──────────────────────────────────────────────────
  const now = Date.now();
  for (const [, entry] of scored) {
    const c = entry.chunk;
    const ageDays = (now - new Date(c.createdAt).getTime()) / 86_400_000;
    entry.score += Math.max(0, 0.1 * (1 - ageDays / 30));        // Recency
    entry.score += Math.min(0.05, c.recallCount * 0.01);          // Frequency
    entry.score += c.tier === 'long-term' ? 0.05 : 0;            // Tier bonus
    entry.score += c.importance * 0.1;                             // Importance (0–0.1)
    if (c.cognitiveLayer === 'procedural') entry.score += 0.05;   // Procedural boost
  }

  // ── Spreading activation (graph walk) ──────────────────────────────
  const seeds = Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const MAX_EDGES = 5;
  for (const parent of seeds) {
    const edges = parent.chunk.relatedMemories.slice(0, MAX_EDGES);
    for (const edge of edges) {
      const hop1Activation = parent.score * edge.weight * 0.5;
      const existing = scored.get(edge.targetId);

      if (existing) {
        existing.score += parent.score * edge.weight * 0.2;
      } else {
        const hop1Chunk = await storage.getChunk(edge.targetId);
        if (hop1Chunk && hop1Chunk.tier !== 'archive') {
          scored.set(edge.targetId, { chunk: hop1Chunk, score: hop1Activation });

          // Second hop
          for (const hop2Edge of hop1Chunk.relatedMemories.slice(0, MAX_EDGES)) {
            if (scored.has(hop2Edge.targetId)) continue;
            const hop2Activation = parent.score * edge.weight * hop2Edge.weight * 0.25;
            const hop2Chunk = await storage.getChunk(hop2Edge.targetId);
            if (hop2Chunk && hop2Chunk.tier !== 'archive') {
              scored.set(hop2Edge.targetId, { chunk: hop2Chunk, score: hop2Activation });
            }
          }
        }
      }
    }
  }

  // ── Sort and apply token budget ────────────────────────────────────
  const sorted = Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  const results: SearchResult[] = [];
  let tokensUsed = 0;

  for (const entry of sorted) {
    const tokens = estimateTokens(entry.chunk.content) + 10;
    if (tokensUsed + tokens > config.maxRecallTokens) break;
    if (results.length >= limit) break;
    results.push({ chunk: entry.chunk, score: entry.score });
    tokensUsed += tokens;

    // Record recall
    await storage.updateChunk(entry.chunk.id, {
      recallCount: entry.chunk.recallCount + 1,
      lastRecalledAt: new Date().toISOString(),
    });
  }

  return results;
}

/**
 * LLM-based relevance selection when >5 results.
 */
export async function selectRelevant(
  config: SmartMemoryConfig,
  query: string,
  candidates: SearchResult[]
): Promise<SearchResult[]> {
  if (candidates.length <= 5) return candidates;

  const manifest = candidates.map((r, i) =>
    `[${i}] (${r.chunk.cognitiveLayer}) ${r.chunk.content.slice(0, 150)}`
  ).join('\n');

  try {
    const response = await llmComplete(
      config,
      'You select which memories are most relevant for the user\'s current message. Return ONLY a JSON array of indices, e.g. [0, 2, 4]. Select up to 5 memories. Prefer procedural rules and recent corrections. Skip redundant or tangential memories.',
      `User message: "${query.slice(0, 200)}"\n\nAvailable memories:\n${manifest}`,
      { maxTokens: 50, temperature: 0 }
    );

    const match = response.match(/\[[\d,\s]*\]/);
    if (match) {
      const indices: number[] = JSON.parse(match[0]);
      const selected = indices
        .filter(i => i >= 0 && i < candidates.length)
        .slice(0, 5)
        .map(i => candidates[i]);
      if (selected.length > 0) return selected;
    }
  } catch {
    // Fall through to top 5
  }

  return candidates.slice(0, 5);
}

/**
 * Format recalled memories for system prompt injection.
 */
export function formatRecalledMemories(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const procedural = results.filter(r => r.chunk.cognitiveLayer === 'procedural');
  const semantic = results.filter(r => r.chunk.cognitiveLayer === 'semantic');
  const episodic = results.filter(r => r.chunk.cognitiveLayer === 'episodic');

  const sections: string[] = [];

  if (procedural.length > 0) {
    sections.push('## How this user works');
    sections.push(procedural.map(r => `- ${r.chunk.content}`).join('\n'));
  }
  if (semantic.length > 0) {
    sections.push('## Known facts');
    sections.push(semantic.map(r => `- [${r.chunk.type}] ${r.chunk.content}`).join('\n'));
  }
  if (episodic.length > 0) {
    sections.push('## Recent context');
    sections.push(episodic.map(r => `- ${r.chunk.content}`).join('\n'));
  }

  return `\n--- RECALLED MEMORIES ---\n${sections.join('\n\n')}\n`;
}
