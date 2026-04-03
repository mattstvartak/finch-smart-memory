# Smart Memory Plugin for OpenClaw

An intelligent memory plugin for [OpenClaw](https://openclaw.ai) that replaces manual memory curation with automatic extraction, hybrid search, and cognitive-science-inspired memory lifecycle management.

Built by **OneNomad LLC**.

## Features

- **LLM-powered extraction** — automatically pulls facts, preferences, decisions, and corrections from conversations
- **Hybrid search** — combines LanceDB native ANN vector search with keyword matching, recency/frequency bonuses, and graph-based spreading activation
- **Tier lifecycle** — memories flow through daily, short-term, long-term, and archive tiers with automatic promotion and decay
- **Procedural rules** — learns behavioral rules from user corrections ("always do X", "never do Y") with confidence tracking
- **WAL (Write-Ahead Log)** — real-time memory capture during conversations, before responding
- **Session state** — hot RAM scratchpad that survives compaction and restarts
- **Mem0 cloud** — optional managed extraction via [Mem0](https://mem0.ai) with auto-deduplication
- **Recall outcomes** — feedback loop that strengthens helpful memories and demotes irrelevant ones
- **Reconsolidation** — re-encodes memories through current context when recalled as helpful
- **Auto-consolidation** — runs maintenance automatically at session start
- **Prompt injection** — automatically injects relevant memories into the system prompt

## Requirements

- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key (for local extraction and search)
- Optional: a [Mem0](https://mem0.ai) API key (for cloud extraction)

## Installation

### From ClawHub

```bash
openclaw plugins install clawhub:@mattstvartak/finch-smart-memory
```

### From npm

```bash
openclaw plugins install finch-smart-memory
```

### Manual install

1. Clone and build:
   ```bash
   git clone https://github.com/mattstvartak/finch-smart-memory.git
   cd finch-smart-memory
   npm install
   npm run build
   ```

2. Install as a local plugin:
   ```bash
   openclaw plugins install ./path/to/finch-smart-memory
   ```

3. Set your API key:
   ```bash
   # Linux/macOS — add to ~/.bashrc, ~/.zshrc, or ~/.profile
   export OPENROUTER_API_KEY="sk-or-your-key-here"

   # Windows — set as system/user environment variable
   setx OPENROUTER_API_KEY "sk-or-your-key-here"

   # Optional: Mem0 cloud extraction
   export MEM0_API_KEY="m0-your-key-here"
   ```

4. Enable the plugin in your OpenClaw config:
   ```json
   {
     "plugins": {
       "entries": {
         "finch-smart-memory": {
           "enabled": true,
           "config": {
             "extractionProvider": "local"
           }
         }
       }
     }
   }
   ```

## Registered Tools

Once installed, the plugin registers these tools that the agent can call:

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid ANN vector + keyword search with spreading activation |
| `memory_format` | Search and format memories for system prompt injection |
| `memory_ingest` | WAL: immediately persist a memory before responding |
| `memory_extract` | Extract memories from a conversation with LLM classification |
| `memory_maintain` | Run consolidation (decay, promote, link, merge) |
| `memory_rules` | Show active procedural rules |
| `memory_outcome` | Record recall outcome (helpful/corrected/irrelevant) |
| `memory_session` | Manage session state (hot RAM) |
| `memory_stats` | Show memory statistics |
| `memory_mem0_sync` | Sync Mem0 cloud memories to local (optional, requires MEM0_API_KEY) |

## Plugin Configuration

Configure in `openclaw.json` under `plugins.entries.finch-smart-memory.config`:

```json
{
  "plugins": {
    "entries": {
      "finch-smart-memory": {
        "enabled": true,
        "config": {
          "extractionProvider": "local",
          "cheapModel": "google/gemini-2.5-flash-lite-preview",
          "embeddingModel": "google/text-embedding-004",
          "mem0UserId": "default",
          "maxRecallChunks": 10,
          "maxRecallTokens": 1500,
          "autoExtract": true,
          "autoMaintain": true
        }
      }
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionProvider` | `local` | `local`, `mem0`, or `both` |
| `cheapModel` | `google/gemini-2.5-flash-lite-preview` | LLM for extraction/classification |
| `embeddingModel` | `google/text-embedding-004` | Embedding model for vector search |
| `mem0UserId` | `default` | Mem0 user scope |
| `maxRecallChunks` | `10` | Max memories returned per search |
| `maxRecallTokens` | `1500` | Token budget for recalled memories |
| `autoExtract` | `true` | Auto-extract memories after conversations |
| `autoMaintain` | `true` | Run consolidation at session start |

### API Keys

Set as environment variables (never stored on disk):

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes (for local extraction) | LLM + embedding calls via OpenRouter |
| `MEM0_API_KEY` | Only for Mem0 features | Mem0 cloud extraction |

## CLI (Standalone)

The plugin also ships a standalone CLI for use outside of OpenClaw:

```bash
node dist/cli.js search "programming preferences"
node dist/cli.js ingest "User prefers dark mode" --type preference
node dist/cli.js maintain
node dist/cli.js stats
node dist/cli.js session show
```

Run `node dist/cli.js` for the full command reference.

## How It Works

### Architecture
```
Conversations ──> Extract ──> LanceDB (vectors + metadata)
                                  |
                    +-------------+-------------+
                    |             |             |
               Vector ANN   Keyword Match   Graph Walk
                    |             |             |
                    +-------------+-------------+
                                  |
                           Score + Rank
                                  |
                         Token Budget Cap
                                  |
                       Format for Prompt
```

### Memory Tiers
```
daily (2d) ──> short-term (14d) ──> long-term (90d) ──> archive
                    ^                                       |
                    +───── reactivation (recalled) ─────────+
```

### Cognitive Layers
- **Episodic** — events tied to a moment ("user debugged OAuth yesterday")
- **Semantic** — enduring facts ("user prefers TypeScript")
- **Procedural** — behavioral rules ("always show code before explanation")

### Spreading Activation
Based on Collins & Loftus (1975). When top-scoring memories are found, the system walks their graph edges to discover related memories not directly matching the query. Two hops deep, with activation decaying at each hop.

### Procedural Rules
Learned from user corrections and explicit instructions. Each rule has a confidence score (0.0-1.0) that increases with reinforcement (+0.1) and decreases with contradiction (-0.2). Dead rules (confidence = 0) are pruned automatically.

### Recall Outcomes
When recalled memories are marked as helpful/corrected/irrelevant:
- **Helpful**: importance +0.05, triggers reconsolidation
- **Corrected**: importance -0.10
- **Irrelevant**: importance -0.05
- Co-recalled helpful memories strengthen their graph edges

## Data Storage

All data lives in `~/.openclaw/smart-memory/`:
```
~/.openclaw/smart-memory/
├── config.json          # Non-secret settings (CLI only)
├── SESSION-STATE.md     # Hot RAM scratchpad
└── lance/               # LanceDB tables
    ├── chunks.lance/    # Memory chunks with embeddings
    ├── daily_logs.lance/# Daily extraction logs
    └── rules.lance/     # Procedural rules
```

## License

MIT
