import * as lancedb from '@lancedb/lancedb';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MemoryChunk,
  MemoryEdge,
  RecallOutcome,
  DailyLogEntry,
  MemoryTier,
  ProceduralRule,
} from './types.js';

// ── Extended chunk with graph + outcome fields ───────────────────────

export interface StoredChunk extends MemoryChunk {
  relatedMemories: MemoryEdge[];
  recallOutcomes: RecallOutcome[];
}

// ── LanceDB Storage ──────────────────────────────────────────────────

export class Storage {
  private db!: lancedb.Connection;
  private chunks!: lancedb.Table;
  private dailyLogs!: lancedb.Table;
  private rules!: lancedb.Table;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(dataDir: string) {
    this.dbPath = join(dataDir, 'lance');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.ready = this.initAsync();
  }

  private async initAsync(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);

    const tableNames = await this.db.tableNames();

    // ── Chunks table ─────────────────────────────────────────────
    if (tableNames.includes('chunks')) {
      this.chunks = await this.db.openTable('chunks');
    } else {
      // Create with a dummy row then delete it (LanceDB needs initial data for schema)
      this.chunks = await this.db.createTable('chunks', [{
        id: '__init__',
        tier: 'daily',
        content: '',
        type: 'fact',
        cognitive_layer: 'semantic',
        tags: '[]',
        source: '',
        importance: 0.5,
        sentiment: 'neutral',
        created_at: new Date().toISOString(),
        last_recalled_at: '',
        recall_count: 0,
        embedding: new Array(768).fill(0),
        related_memories: '[]',
        recall_outcomes: '[]',
      }]);
      await this.chunks.delete('id = \'__init__\'');
    }

    // ── Daily logs table ─────────────────────────────────────────
    if (tableNames.includes('daily_logs')) {
      this.dailyLogs = await this.db.openTable('daily_logs');
    } else {
      this.dailyLogs = await this.db.createTable('daily_logs', [{
        row_id: '__init__',
        date: '',
        timestamp: '',
        conversation_id: '',
        summary: '',
        extracted_facts: '[]',
      }]);
      await this.dailyLogs.delete('row_id = \'__init__\'');
    }

    // ── Rules table ──────────────────────────────────────────────
    if (tableNames.includes('rules')) {
      this.rules = await this.db.openTable('rules');
    } else {
      this.rules = await this.db.createTable('rules', [{
        id: '__init__',
        rule: '',
        domain: 'general',
        confidence: 0.5,
        reinforcements: 0,
        contradictions: 0,
        evidence: '[]',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]);
      await this.rules.delete('id = \'__init__\'');
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  // ── Chunk Operations ───────────────────────────────────────────────

  async saveChunk(chunk: StoredChunk): Promise<void> {
    // Delete existing if present (upsert)
    try { await this.chunks.delete(`id = '${esc(chunk.id)}'`); } catch { /* noop */ }

    await this.chunks.add([{
      id: chunk.id,
      tier: chunk.tier,
      content: chunk.content,
      type: chunk.type,
      cognitive_layer: chunk.cognitiveLayer,
      tags: JSON.stringify(chunk.tags),
      source: chunk.source,
      importance: chunk.importance,
      sentiment: chunk.sentiment,
      created_at: chunk.createdAt,
      last_recalled_at: chunk.lastRecalledAt ?? '',
      recall_count: chunk.recallCount,
      embedding: chunk.embedding ?? new Array(768).fill(0),
      related_memories: JSON.stringify(chunk.relatedMemories),
      recall_outcomes: JSON.stringify(chunk.recallOutcomes),
    }]);
  }

  async getChunk(id: string): Promise<StoredChunk | null> {
    const rows = await this.chunks.query()
      .where(`id = '${esc(id)}'`)
      .limit(1)
      .toArray();
    return rows.length > 0 ? rowToChunk(rows[0]) : null;
  }

  async deleteChunk(id: string): Promise<void> {
    await this.chunks.delete(`id = '${esc(id)}'`);
  }

  async listChunks(opts?: { excludeTiers?: MemoryTier[]; tier?: MemoryTier; cognitiveLayer?: string }): Promise<StoredChunk[]> {
    let q = this.chunks.query();
    const conditions: string[] = [];

    if (opts?.excludeTiers && opts.excludeTiers.length > 0) {
      for (const t of opts.excludeTiers) {
        conditions.push(`tier != '${esc(t)}'`);
      }
    }
    if (opts?.tier) {
      conditions.push(`tier = '${esc(opts.tier)}'`);
    }
    if (opts?.cognitiveLayer) {
      conditions.push(`cognitive_layer = '${esc(opts.cognitiveLayer)}'`);
    }

    if (conditions.length > 0) {
      q = q.where(conditions.join(' AND '));
    }

    const rows = await q.toArray();
    return rows.map(rowToChunk);
  }

  async updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void> {
    const values: Record<string, any> = {};

    if (updates.tier !== undefined) values.tier = updates.tier;
    if (updates.content !== undefined) values.content = updates.content;
    if (updates.importance !== undefined) values.importance = updates.importance;
    if (updates.recallCount !== undefined) values.recall_count = updates.recallCount;
    if (updates.lastRecalledAt !== undefined) values.last_recalled_at = updates.lastRecalledAt ?? '';
    if (updates.relatedMemories !== undefined) values.related_memories = JSON.stringify(updates.relatedMemories);
    if (updates.recallOutcomes !== undefined) values.recall_outcomes = JSON.stringify(updates.recallOutcomes);
    if (updates.embedding !== undefined) values.embedding = updates.embedding ?? new Array(768).fill(0);

    if (Object.keys(values).length === 0) return;
    await this.chunks.update({ where: `id = '${esc(id)}'`, values });
  }

  async chunkCount(): Promise<number> {
    return await this.chunks.countRows();
  }

  /**
   * Native ANN vector search via LanceDB.
   * Returns chunks sorted by vector similarity (cosine distance).
   */
  async vectorSearch(queryEmbedding: number[], limit: number, filter?: string): Promise<Array<{ chunk: StoredChunk; distance: number }>> {
    let q = this.chunks
      .vectorSearch(queryEmbedding)
      .distanceType('cosine')
      .limit(limit);

    if (filter) {
      q = q.where(filter);
    }

    const rows = await q.toArray();
    return rows.map(row => ({
      chunk: rowToChunk(row),
      distance: row._distance ?? 1,
    }));
  }

  // ── Daily Logs ─────────────────────────────────────────────────────

  async appendDailyEntry(date: string, entry: DailyLogEntry): Promise<void> {
    await this.dailyLogs.add([{
      row_id: `${date}-${Date.now()}`,
      date,
      timestamp: entry.timestamp,
      conversation_id: entry.conversationId,
      summary: entry.summary,
      extracted_facts: JSON.stringify(entry.extractedFacts),
    }]);
  }

  async getDailyLogs(daysBack: number): Promise<Array<{ date: string; entries: DailyLogEntry[] }>> {
    const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().split('T')[0];
    const rows = await this.dailyLogs.query()
      .where(`date >= '${esc(cutoff)}'`)
      .toArray();

    const grouped = new Map<string, DailyLogEntry[]>();
    for (const row of rows) {
      const entries = grouped.get(row.date) ?? [];
      entries.push({
        timestamp: row.timestamp,
        conversationId: row.conversation_id,
        summary: row.summary,
        extractedFacts: JSON.parse(row.extracted_facts),
      });
      grouped.set(row.date, entries);
    }

    return Array.from(grouped.entries()).map(([date, entries]) => ({ date, entries }));
  }

  // ── Procedural Rules ───────────────────────────────────────────────

  async saveRule(rule: ProceduralRule): Promise<void> {
    try { await this.rules.delete(`id = '${esc(rule.id)}'`); } catch { /* noop */ }

    await this.rules.add([{
      id: rule.id,
      rule: rule.rule,
      domain: rule.domain,
      confidence: rule.confidence,
      reinforcements: rule.reinforcements,
      contradictions: rule.contradictions,
      evidence: JSON.stringify(rule.evidence),
      created_at: rule.createdAt,
      updated_at: rule.updatedAt,
    }]);
  }

  async getRules(): Promise<ProceduralRule[]> {
    const rows = await this.rules.query().toArray();
    return rows
      .map(r => ({
        id: r.id,
        rule: r.rule,
        domain: r.domain,
        confidence: r.confidence,
        reinforcements: r.reinforcements,
        contradictions: r.contradictions,
        evidence: JSON.parse(r.evidence),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  async deleteRule(id: string): Promise<void> {
    await this.rules.delete(`id = '${esc(id)}'`);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  close(): void {
    // LanceDB connections don't need explicit closing in the JS driver
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function esc(val: string): string {
  return val.replace(/'/g, "''");
}

function rowToChunk(row: any): StoredChunk {
  let embedding: number[] | undefined;
  if (row.embedding) {
    // LanceDB returns Float32Array or regular array
    embedding = Array.isArray(row.embedding) ? row.embedding : Array.from(row.embedding);
    // Check if it's a zero-fill placeholder
    if (embedding && embedding.every(v => v === 0)) embedding = undefined;
  }

  return {
    id: row.id,
    tier: row.tier,
    content: row.content,
    type: row.type,
    cognitiveLayer: row.cognitive_layer,
    tags: JSON.parse(row.tags ?? '[]'),
    source: row.source ?? '',
    importance: row.importance ?? 0.5,
    sentiment: row.sentiment ?? 'neutral',
    createdAt: row.created_at,
    lastRecalledAt: row.last_recalled_at || null,
    recallCount: row.recall_count ?? 0,
    embedding,
    relatedMemories: JSON.parse(row.related_memories ?? '[]'),
    recallOutcomes: JSON.parse(row.recall_outcomes ?? '[]'),
  };
}
