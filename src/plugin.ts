import { Type } from '@sinclair/typebox';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Storage } from './storage.js';
import { loadConfig } from './config.js';
import { setLlmProvider } from './llm.js';
import { extractFromConversation } from './extractor.js';
import { search, selectRelevant, formatRecalledMemories } from './search.js';
import { consolidate } from './consolidator.js';
import { extractRules, formatRulesForPrompt } from './procedural.js';
import { recordRecallOutcome } from './outcome.js';
import { mem0Extract, mem0Search, mem0SyncAll } from './mem0.js';
import { ingest } from './wal.js';
import {
  readSessionState,
  updateSessionState,
  appendToSessionState,
  clearSessionState,
} from './session-state.js';
import type { SmartMemoryConfig } from './types.js';

// ── Lazy-init storage singleton ──────────────────────────────────────

let _storage: Storage | null = null;
let _storageReady: Promise<void> | null = null;

function getStorage(config: SmartMemoryConfig): Storage {
  if (!_storage) {
    _storage = new Storage(config.dataDir);
    _storageReady = _storage.ensureReady();
  }
  return _storage;
}

async function ensureStorage(config: SmartMemoryConfig): Promise<Storage> {
  const s = getStorage(config);
  await _storageReady;
  return s;
}

// ── Text result helper ───────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: any) {
  return textResult(JSON.stringify(data, null, 2));
}

// ── Plugin Definition ────────────────────────────────────────────────

// We use a plain object export since we can't import the real SDK at dev time.
// OpenClaw reads the openclaw metadata from package.json and loads this module.
const plugin = {
  id: 'finch-smart-memory',
  name: 'Smart Memory',
  description: 'Intelligent memory manager with LLM-powered extraction, hybrid ANN vector search, tier lifecycle, spreading activation, procedural rules, WAL, Mem0, and session-state hot RAM.',
  kind: 'memory' as const,

  register(api: any) {
    const pluginConfig = api.pluginConfig ?? {};
    const config = loadConfig({
      extractionProvider: pluginConfig.extractionProvider,
      cheapModel: pluginConfig.cheapModel,
      embeddingModel: pluginConfig.embeddingModel,
      mem0UserId: pluginConfig.mem0UserId,
      maxRecallChunks: pluginConfig.maxRecallChunks,
      maxRecallTokens: pluginConfig.maxRecallTokens,
    });

    // ── Wire LLM through OpenClaw's runtime ──────────────────────
    // Routes all LLM and embedding calls through the user's existing
    // model provider. No separate API key needed.
    setLlmProvider({
      async complete(systemPrompt: string, userMessage: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
        const result = await api.runtime.subagent.run({
          prompt: userMessage,
          systemPrompt,
          maxTokens: opts?.maxTokens ?? 1000,
          temperature: opts?.temperature ?? 0,
          model: config.cheapModel || undefined,
        });
        return result?.text ?? result?.content ?? '';
      },
      async embed(text: string): Promise<number[]> {
        // Use modelAuth to resolve the user's API key for embedding calls
        const key = await api.runtime.modelAuth?.resolveApiKey?.(config.embeddingModel);
        if (!key) throw new Error('No embedding provider available. Configure a model provider in OpenClaw.');

        // Determine the base URL from the model prefix
        const provider = config.embeddingModel.split('/')[0] ?? 'openrouter';
        const baseUrls: Record<string, string> = {
          openrouter: 'https://openrouter.ai/api/v1',
          openai: 'https://api.openai.com/v1',
          google: 'https://generativelanguage.googleapis.com/v1beta',
        };
        const baseUrl = baseUrls[provider] ?? 'https://openrouter.ai/api/v1';

        const res = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model: config.embeddingModel, input: text }),
        });
        if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
        const data = await res.json() as any;
        return data.data?.[0]?.embedding ?? [];
      },
    });

    // ── memory_search ────────────────────────────────────────────
    api.registerTool({
      name: 'memory_search',
      label: 'Memory Search',
      description: 'Search long-term memories using hybrid ANN vector + keyword search with spreading activation. Returns relevant facts, preferences, decisions, and procedural rules about the user.',
      parameters: Type.Object({
        query: Type.String({ description: 'Natural language search query.' }),
        maxResults: Type.Optional(Type.Number({ description: 'Max results to return (default: 10).', minimum: 1, maximum: 50 })),
      }),
      async execute(_id: string, params: { query: string; maxResults?: number }) {
        const storage = await ensureStorage(config);
        const results = await search(config, storage, params.query, params.maxResults);
        const selected = await selectRelevant(config, params.query, results);
        return jsonResult({
          total: results.length,
          selected: selected.length,
          results: selected.map(r => ({
            id: r.chunk.id,
            content: r.chunk.content,
            type: r.chunk.type,
            layer: r.chunk.cognitiveLayer,
            tier: r.chunk.tier,
            importance: r.chunk.importance,
            score: Math.round(r.score * 1000) / 1000,
          })),
        });
      },
    });

    // ── memory_format ────────────────────────────────────────────
    api.registerTool({
      name: 'memory_format',
      label: 'Memory Format',
      description: 'Search and format recalled memories for system prompt injection. Returns structured text grouped by cognitive layer (procedural rules, known facts, recent context).',
      parameters: Type.Object({
        query: Type.String({ description: 'Topic or question to recall memories for.' }),
      }),
      async execute(_id: string, params: { query: string }) {
        const storage = await ensureStorage(config);
        const results = await search(config, storage, params.query);
        const selected = await selectRelevant(config, params.query, results);
        const text = formatRecalledMemories(selected);
        const rules = await formatRulesForPrompt(storage);
        return textResult(text + rules || 'No relevant memories found.');
      },
    });

    // ── memory_ingest ────────────────────────────────────────────
    api.registerTool({
      name: 'memory_ingest',
      label: 'Memory Ingest (WAL)',
      description: 'Write-ahead log: immediately persist a memory BEFORE responding. Use when the user states a preference, makes a decision, corrects you, or shares an important fact.',
      parameters: Type.Object({
        content: Type.String({ description: 'The memory to store.' }),
        type: Type.Optional(Type.String({ description: 'Memory type: fact, preference, decision, context, or correction.' })),
        importance: Type.Optional(Type.Number({ description: 'Importance 0.0-1.0 (default: 0.5).', minimum: 0, maximum: 1 })),
        tags: Type.Optional(Type.String({ description: 'Comma-separated tags.' })),
      }),
      async execute(_id: string, params: { content: string; type?: string; importance?: number; tags?: string }) {
        const storage = await ensureStorage(config);
        const chunks = await ingest(config, storage, [{
          content: params.content,
          type: params.type as any,
          importance: params.importance,
          tags: params.tags?.split(',').map(t => t.trim()),
        }]);
        return jsonResult({
          ingested: chunks.length,
          memory: chunks[0] ? { id: chunks[0].id, content: chunks[0].content, type: chunks[0].type, layer: chunks[0].cognitiveLayer } : null,
        });
      },
    });

    // ── memory_extract ───────────────────────────────────────────
    api.registerTool({
      name: 'memory_extract',
      label: 'Memory Extract',
      description: 'Extract memories from a conversation. Automatically classifies into facts, preferences, decisions, corrections with cognitive layers and importance scores.',
      parameters: Type.Object({
        messages: Type.String({ description: 'JSON string of message array: [{role: "user", content: "..."}, ...]' }),
        conversationId: Type.Optional(Type.String({ description: 'Session/conversation identifier.' })),
      }),
      async execute(_id: string, params: { messages: string; conversationId?: string }) {
        const storage = await ensureStorage(config);
        const messages = JSON.parse(params.messages);
        const convId = params.conversationId ?? `plugin-${Date.now()}`;

        const allChunks: any[] = [];

        if (config.extractionProvider === 'local' || config.extractionProvider === 'both') {
          const chunks = await extractFromConversation(config, storage, messages, convId);
          allChunks.push(...chunks.map(c => ({ id: c.id, content: c.content, type: c.type, layer: c.cognitiveLayer, importance: c.importance, source: 'local' })));
        }
        if (config.extractionProvider === 'mem0' || config.extractionProvider === 'both') {
          const chunks = await mem0Extract(config, storage, messages, convId);
          allChunks.push(...chunks.map(c => ({ id: c.id, content: c.content, type: c.type, layer: c.cognitiveLayer, importance: c.importance, source: 'mem0' })));
        }

        return jsonResult({ extracted: allChunks.length, memories: allChunks });
      },
    });

    // ── memory_maintain ──────────────────────────────────────────
    api.registerTool({
      name: 'memory_maintain',
      label: 'Memory Maintain',
      description: 'Run memory consolidation: decay importance, promote/demote tiers, link related memories, merge near-duplicates.',
      parameters: Type.Object({}),
      async execute() {
        const storage = await ensureStorage(config);
        const stats = await consolidate(storage);
        return jsonResult({ action: 'consolidation', ...stats });
      },
    });

    // ── memory_rules ─────────────────────────────────────────────
    api.registerTool({
      name: 'memory_rules',
      label: 'Memory Rules',
      description: 'Show active procedural rules learned from user corrections and preferences. Rules guide agent behavior.',
      parameters: Type.Object({}),
      async execute() {
        const storage = await ensureStorage(config);
        const text = await formatRulesForPrompt(storage);
        return textResult(text || 'No active procedural rules.');
      },
    });

    // ── memory_outcome ───────────────────────────────────────────
    api.registerTool({
      name: 'memory_outcome',
      label: 'Memory Outcome',
      description: 'Record whether recalled memories were helpful, corrected, or irrelevant. Adjusts importance and strengthens graph edges.',
      parameters: Type.Object({
        outcome: Type.String({ description: 'Outcome: helpful, corrected, or irrelevant.' }),
        chunkIds: Type.String({ description: 'Comma-separated memory chunk IDs.' }),
      }),
      async execute(_id: string, params: { outcome: string; chunkIds: string }) {
        const storage = await ensureStorage(config);
        const ids = params.chunkIds.split(',').map(id => id.trim());
        await recordRecallOutcome(config, storage, ids, params.outcome as any, `plugin-${Date.now()}`);
        return textResult(`Recorded ${params.outcome} outcome for ${ids.length} chunk(s).`);
      },
    });

    // ── memory_session ───────────────────────────────────────────
    api.registerTool({
      name: 'memory_session',
      label: 'Memory Session State',
      description: 'Manage session state (hot RAM). Actions: show, task, context, decision, action, clear. Survives compaction and restarts.',
      parameters: Type.Object({
        action: Type.String({ description: 'Action: show, task, context, decision, action, or clear.' }),
        value: Type.Optional(Type.String({ description: 'Value for the action (required for task/context/decision/action).' })),
      }),
      async execute(_id: string, params: { action: string; value?: string }) {
        switch (params.action) {
          case 'show':
            return jsonResult(readSessionState(config.dataDir));
          case 'task':
            updateSessionState(config.dataDir, { currentTask: params.value ?? '' });
            return textResult(`Task set: ${params.value}`);
          case 'context':
            appendToSessionState(config.dataDir, 'keyContext', params.value ?? '');
            return textResult(`Context added: ${params.value}`);
          case 'decision':
            appendToSessionState(config.dataDir, 'recentDecisions', params.value ?? '');
            return textResult(`Decision recorded: ${params.value}`);
          case 'action':
            appendToSessionState(config.dataDir, 'pendingActions', { text: params.value ?? '', done: false });
            return textResult(`Action added: ${params.value}`);
          case 'clear':
            clearSessionState(config.dataDir);
            return textResult('Session state cleared.');
          default:
            return textResult(`Unknown action: ${params.action}. Use: show, task, context, decision, action, clear.`);
        }
      },
    });

    // ── memory_stats ─────────────────────────────────────────────
    api.registerTool({
      name: 'memory_stats',
      label: 'Memory Stats',
      description: 'Show memory statistics: chunk counts by tier/layer/type, rule counts, session state.',
      parameters: Type.Object({}),
      async execute() {
        const storage = await ensureStorage(config);
        const all = await storage.listChunks();
        const tiers: Record<string, number> = {};
        const layers: Record<string, number> = {};
        const types: Record<string, number> = {};
        for (const c of all) {
          tiers[c.tier] = (tiers[c.tier] ?? 0) + 1;
          layers[c.cognitiveLayer] = (layers[c.cognitiveLayer] ?? 0) + 1;
          types[c.type] = (types[c.type] ?? 0) + 1;
        }
        const rules = await storage.getRules();
        const state = readSessionState(config.dataDir);
        return jsonResult({
          totalChunks: all.length,
          byTier: tiers,
          byLayer: layers,
          byType: types,
          proceduralRules: rules.length,
          activeRules: rules.filter(r => r.confidence > 0.3).length,
          extractionProvider: config.extractionProvider,
          mem0Enabled: !!config.mem0ApiKey,
          sessionTask: state.currentTask || null,
        });
      },
    });

    // ── memory_mem0_sync ─────────────────────────────────────────
    api.registerTool({
      name: 'memory_mem0_sync',
      label: 'Mem0 Sync',
      description: 'Sync all memories from Mem0 cloud to local LanceDB store. Requires MEM0_API_KEY.',
      parameters: Type.Object({}),
      async execute() {
        const storage = await ensureStorage(config);
        const count = await mem0SyncAll(config, storage);
        return textResult(`Synced ${count} new memories from Mem0 cloud.`);
      },
    }, { optional: true });

    // ── Lifecycle Hooks ──────────────────────────────────────────

    const autoExtract = pluginConfig.autoExtract !== false;
    const autoMaintain = pluginConfig.autoMaintain !== false;

    if (autoMaintain) {
      api.on('session_start', async () => {
        try {
          const storage = await ensureStorage(config);
          await consolidate(storage);
          api.logger?.debug('Smart memory: auto-consolidation complete');
        } catch (err: any) {
          api.logger?.warn({ error: err.message }, 'Smart memory: auto-consolidation failed');
        }
      });
    }

    // ── Memory Prompt Guidance ─────────────────────────────────────
    // Inject tool usage guidance into the system prompt via hook.

    const MEMORY_GUIDANCE = [
      '## Smart Memory',
      'Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search to find relevant memories.',
      'Use memory_ingest to immediately save important facts, preferences, decisions, or corrections the user shares — write before responding (WAL principle).',
      'Use memory_format to get a structured recall block for the current topic.',
    ].join('\n');

    api.on('before_prompt_build', async () => ({
      prependSystemContext: MEMORY_GUIDANCE,
    }));

    api.logger?.info('Smart Memory plugin registered');
  },
};

export default plugin;
