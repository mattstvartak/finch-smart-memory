#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, setConfigValue, getPersistedConfig } from './config.js';
import { Storage } from './storage.js';
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

const [,, command, ...args] = process.argv;

async function main() {
  // Handle config command before loading storage (no DB needed)
  if (command === 'config') {
    const SECRET_KEYS = ['apikey', 'mem0apikey', 'openrouterapikey'];
    const sub = args[0];

    if (sub === 'set' && args[1] && args.length >= 3) {
      if (SECRET_KEYS.includes(args[1].toLowerCase())) {
        console.error(`Refusing to write "${args[1]}" to disk — API keys should be set as environment variables.`);
        console.error('');
        if (args[1].toLowerCase().includes('mem0')) {
          console.error('  export MEM0_API_KEY="your-key-here"');
        } else {
          console.error('  export OPENROUTER_API_KEY="your-key-here"');
        }
        process.exit(1);
      }
      setConfigValue(args[1], args[2]);
      console.log(`Set ${args[1]} = ${args[2]}`);

    } else if (sub === 'get') {
      const cfg = getPersistedConfig();
      if (args[1]) {
        console.log(cfg[args[1]] ?? '(not set)');
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }

    } else if (sub === 'check') {
      const config = loadConfig();
      console.log(JSON.stringify({
        openRouterApiKey: config.openRouterApiKey ? 'set' : 'missing',
        mem0ApiKey: config.mem0ApiKey ? 'set' : 'missing',
        mem0UserId: config.mem0UserId,
        extractionProvider: config.extractionProvider,
        cheapModel: config.cheapModel,
        embeddingModel: config.embeddingModel,
        dataDir: config.dataDir,
      }, null, 2));

    } else {
      console.log(`Config commands:
  config get [key]           Show saved settings
  config set <key> <value>   Set a non-secret config value
  config check               Show resolved config (keys shown as set/missing)

Settings (stored in ~/.openclaw/smart-memory/config.json):
  mem0UserId                 Mem0 user scope
  extractionProvider         'local', 'mem0', or 'both'
  cheapModel                 LLM model for extraction
  embeddingModel             Embedding model
  maxRecallChunks            Max memories per search (default: 10)
  maxRecallTokens            Token budget for recalled memories (default: 1500)

API keys (set as environment variables, NOT stored on disk):
  OPENROUTER_API_KEY         Required for local extraction/search
  MEM0_API_KEY               Required for Mem0 operations`);
    }
    return;
  }

  const config = loadConfig();

  const needsApiKey = ['extract', 'search', 'format'].includes(command ?? '') || (command === 'rules' && args[0] === 'extract');
  const needsMem0 = command === 'mem0' || (needsApiKey && (config.extractionProvider === 'mem0' || config.extractionProvider === 'both'));
  const needsOpenRouter = needsApiKey && config.extractionProvider !== 'mem0';

  if (!config.openRouterApiKey && needsOpenRouter) {
    console.error('Error: OPENROUTER_API_KEY not found.');
    console.error('Set via: smart-memory config set apiKey <key>');
    console.error('Or set OPENROUTER_API_KEY environment variable');
    process.exit(1);
  }

  if (needsMem0 && !config.mem0ApiKey) {
    console.error('Error: MEM0_API_KEY not found.');
    console.error('Set via: smart-memory config set mem0ApiKey <key>');
    console.error('Or set MEM0_API_KEY environment variable');
    process.exit(1);
  }

  const storage = new Storage(config.dataDir);
  await storage.ensureReady();

  switch (command) {
    case 'extract': {
      const filePath = args[0];
      const conversationId = args[1] ?? `cli-${Date.now()}`;
      let messages: Array<{ role: string; content: string }>;

      if (!filePath) {
        messages = JSON.parse(readFileSync(0, 'utf-8'));
      } else {
        if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
        messages = JSON.parse(readFileSync(resolve(filePath), 'utf-8'));
      }

      const allChunks: Array<{ id: string; content: string; type: string; layer: string; importance: number; source: string }> = [];

      // Local extraction (OpenRouter LLM)
      if (config.extractionProvider === 'local' || config.extractionProvider === 'both') {
        const chunks = await extractFromConversation(config, storage, messages, conversationId);
        allChunks.push(...chunks.map(c => ({ id: c.id, content: c.content, type: c.type, layer: c.cognitiveLayer, importance: c.importance, source: 'local' })));
      }

      // Mem0 extraction
      if (config.extractionProvider === 'mem0' || config.extractionProvider === 'both') {
        const chunks = await mem0Extract(config, storage, messages, conversationId);
        allChunks.push(...chunks.map(c => ({ id: c.id, content: c.content, type: c.type, layer: c.cognitiveLayer, importance: c.importance, source: 'mem0' })));
      }

      console.log(JSON.stringify({ extracted: allChunks.length, memories: allChunks }, null, 2));
      break;
    }

    case 'search': {
      const query = args.join(' ');
      if (!query) { console.error('Usage: smart-memory search <query>'); process.exit(1); }

      const results = await search(config, storage, query);
      const selected = await selectRelevant(config, query, results);

      console.log(JSON.stringify({
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
      }, null, 2));
      break;
    }

    case 'format': {
      const query = args.join(' ');
      if (!query) { console.error('Usage: smart-memory format <query>'); process.exit(1); }

      const results = await search(config, storage, query);
      const selected = await selectRelevant(config, query, results);
      const text = formatRecalledMemories(selected);
      const rules = await formatRulesForPrompt(storage);
      console.log(text + rules);
      break;
    }

    case 'maintain': {
      const stats = await consolidate(storage);
      console.log(JSON.stringify({ action: 'consolidation', ...stats }, null, 2));
      break;
    }

    case 'rules': {
      if (args[0] === 'extract') {
        const filePath = args[1];
        let messages: Array<{ role: string; content: string }>;
        if (!filePath) {
          messages = JSON.parse(readFileSync(0, 'utf-8'));
        } else {
          messages = JSON.parse(readFileSync(resolve(filePath), 'utf-8'));
        }
        await extractRules(config, storage, messages);
        console.log('Rules updated.');
      } else {
        const text = await formatRulesForPrompt(storage);
        console.log(text || 'No active procedural rules.');
      }
      break;
    }

    case 'outcome': {
      const outcomeType = args[0] as 'helpful' | 'corrected' | 'irrelevant';
      const chunkIds = args.slice(1);
      if (!outcomeType || chunkIds.length === 0) {
        console.error('Usage: smart-memory outcome <helpful|corrected|irrelevant> <chunkId1> [chunkId2...]');
        process.exit(1);
      }
      await recordRecallOutcome(config, storage, chunkIds, outcomeType, `cli-${Date.now()}`);
      console.log(`Recorded ${outcomeType} outcome for ${chunkIds.length} chunk(s).`);
      break;
    }

    // ── Mem0 Commands ────────────────────────────────────────────────

    case 'mem0': {
      const sub = args[0];

      if (sub === 'extract') {
        const filePath = args[1];
        const convId = args[2] ?? `mem0-${Date.now()}`;
        let messages: Array<{ role: string; content: string }>;
        if (!filePath) {
          messages = JSON.parse(readFileSync(0, 'utf-8'));
        } else {
          messages = JSON.parse(readFileSync(resolve(filePath), 'utf-8'));
        }
        const chunks = await mem0Extract(config, storage, messages, convId);
        console.log(JSON.stringify({ extracted: chunks.length, memories: chunks.map(c => ({ id: c.id, content: c.content, type: c.type })) }, null, 2));

      } else if (sub === 'search') {
        const query = args.slice(1).join(' ');
        if (!query) { console.error('Usage: smart-memory mem0 search <query>'); process.exit(1); }
        const results = await mem0Search(config, query);
        console.log(JSON.stringify({ results }, null, 2));

      } else if (sub === 'sync') {
        const count = await mem0SyncAll(config, storage);
        console.log(`Synced ${count} new memories from Mem0 cloud.`);

      } else {
        console.log(`Mem0 commands:
  mem0 extract [file] [convId]  Extract via Mem0 cloud + sync to local
  mem0 search <query>           Search Mem0 cloud directly
  mem0 sync                     Sync all Mem0 memories to local LanceDB`);
      }
      break;
    }

    // ── WAL Ingest ───────────────────────────────────────────────────

    case 'ingest': {
      // Quick WAL ingest: smart-memory ingest "User prefers dark mode" [--type preference] [--importance 0.8]
      let content = '';
      let type: string | undefined;
      let importance: number | undefined;
      let tags: string[] = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--type' && args[i + 1]) { type = args[++i]; }
        else if (args[i] === '--importance' && args[i + 1]) { importance = parseFloat(args[++i]); }
        else if (args[i] === '--tags' && args[i + 1]) { tags = args[++i].split(','); }
        else { content += (content ? ' ' : '') + args[i]; }
      }

      if (!content) {
        // Read from stdin (JSON array of IngestEntry objects)
        const input = readFileSync(0, 'utf-8');
        const entries = JSON.parse(input);
        const chunks = await ingest(config, storage, entries);
        console.log(JSON.stringify({ ingested: chunks.length }, null, 2));
      } else {
        const chunks = await ingest(config, storage, [{
          content,
          type: type as any,
          importance,
          tags,
        }]);
        console.log(JSON.stringify({
          ingested: chunks.length,
          memory: chunks[0] ? { id: chunks[0].id, content: chunks[0].content, type: chunks[0].type, layer: chunks[0].cognitiveLayer } : null,
        }, null, 2));
      }
      break;
    }

    // ── Session State ────────────────────────────────────────────────

    case 'session': {
      const sub = args[0];

      if (sub === 'show') {
        const state = readSessionState(config.dataDir);
        console.log(JSON.stringify(state, null, 2));

      } else if (sub === 'task') {
        const task = args.slice(1).join(' ');
        if (!task) { console.error('Usage: smart-memory session task <description>'); process.exit(1); }
        updateSessionState(config.dataDir, { currentTask: task });
        console.log(`Current task set: ${task}`);

      } else if (sub === 'context') {
        const ctx = args.slice(1).join(' ');
        if (!ctx) { console.error('Usage: smart-memory session context <info>'); process.exit(1); }
        appendToSessionState(config.dataDir, 'keyContext', ctx);
        console.log(`Context added: ${ctx}`);

      } else if (sub === 'decision') {
        const dec = args.slice(1).join(' ');
        if (!dec) { console.error('Usage: smart-memory session decision <text>'); process.exit(1); }
        appendToSessionState(config.dataDir, 'recentDecisions', dec);
        console.log(`Decision recorded: ${dec}`);

      } else if (sub === 'action') {
        const action = args.slice(1).join(' ');
        if (!action) { console.error('Usage: smart-memory session action <text>'); process.exit(1); }
        appendToSessionState(config.dataDir, 'pendingActions', { text: action, done: false });
        console.log(`Action added: ${action}`);

      } else if (sub === 'clear') {
        clearSessionState(config.dataDir);
        console.log('Session state cleared.');

      } else {
        console.log(`Session state commands (hot RAM):
  session show                  Show current session state
  session task <description>    Set current task
  session context <info>        Add key context
  session decision <text>       Record a decision
  session action <text>         Add pending action
  session clear                 Clear session state`);
      }
      break;
    }

    case 'stats': {
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

      console.log(JSON.stringify({
        totalChunks: all.length,
        byTier: tiers,
        byLayer: layers,
        byType: types,
        proceduralRules: rules.length,
        activeRules: rules.filter(r => r.confidence > 0.3).length,
        extractionProvider: config.extractionProvider,
        mem0Enabled: !!config.mem0ApiKey,
        sessionTask: state.currentTask || null,
      }, null, 2));
      break;
    }

    default:
      console.log(`openclaw-smart-memory — Intelligent memory manager for OpenClaw (LanceDB + Mem0)

Commands:
  extract [file] [convId]  Extract memories (uses configured provider: local/mem0/both)
  search <query>           Hybrid ANN vector + keyword search
  format <query>           Format recalled memories for system prompt
  maintain                 Run consolidation (decay, promote, link, merge)
  rules                    Show active procedural rules
  rules extract [file]     Extract procedural rules from conversation
  outcome <type> <ids...>  Record recall outcome (helpful/corrected/irrelevant)
  stats                    Show memory statistics

  ingest <text> [--type T] [--importance N] [--tags a,b]
                           WAL: immediately persist a memory (write-ahead)

  mem0 extract [file]      Extract via Mem0 cloud + sync to local
  mem0 search <query>      Search Mem0 cloud directly
  mem0 sync                Sync all Mem0 memories to local LanceDB

  session show             Show current session state (hot RAM)
  session task <text>      Set current task
  session context <info>   Add key context
  session decision <text>  Record a decision
  session action <text>    Add pending action
  session clear            Clear session state

  config get [key]         Show skill config (from openclaw.json)
  config set <key> <value> Set a config value (e.g. mem0ApiKey, apiKey)
`);
      break;
  }

  storage.close();
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
