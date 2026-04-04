# OpenClaw Smart Memory Plugin

An intelligent memory plugin for [OpenClaw](https://openclaw.ai) that replaces manual memory curation with automatic extraction, hybrid search, and cognitive-science-inspired memory lifecycle management. Uses your existing OpenClaw model provider — no extra API keys required.


## Features

- **LLM-powered extraction** — automatically pulls facts, preferences, decisions, and corrections from conversations using your configured model
- **Hybrid search** — combines LanceDB native ANN vector search with keyword matching, recency/frequency bonuses, and graph-based spreading activation
- **Tier lifecycle** — memories flow through daily, short-term, long-term, and archive tiers with automatic promotion and decay
- **Procedural rules** — learns behavioral rules from user corrections ("always do X", "never do Y") with confidence tracking
- **WAL (Write-Ahead Log)** — real-time memory capture during conversations, before responding
- **Session state** — hot RAM scratchpad that survives compaction and restarts
- **Mem0 cloud** — optional managed extraction via [Mem0](https://mem0.ai) with auto-deduplication
- **Recall outcomes** — feedback loop that strengthens helpful memories and demotes irrelevant ones
- **Auto-consolidation** — runs maintenance automatically at session start
- **Prompt injection** — automatically injects relevant memories into the system prompt

## Installation

### From ClawHub

```bash
openclaw plugins install clawhub:openclaw-smart-memory-plugin
```

### From npm

```bash
openclaw plugins install openclaw-smart-memory-plugin
```

### Manual install (from source)

```bash
git clone https://github.com/mattstvartak/openclaw-smart-memory-plugin.git
cd openclaw-smart-memory-plugin
npm install
npm run build
openclaw plugins install ./
```

## Updating

### From ClawHub

```bash
openclaw plugins update openclaw-smart-memory-plugin
```

Or update all plugins at once:

```bash
openclaw plugins update --all
```

### Manual update (from source)

```bash
cd openclaw-smart-memory-plugin
git pull
npm install
npm run build
```

## Configuration

Enable the plugin in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-smart-memory-plugin": {
        "enabled": true
      }
    }
  }
}
```

### Settings

All settings are optional. Configure under `plugins.entries.openclaw-smart-memory-plugin.config`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-smart-memory-plugin": {
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
| `extractionProvider` | `local` | `local` (your OpenClaw model), `mem0`, or `both` |
| `cheapModel` | `google/gemini-2.5-flash-lite-preview` | Model for extraction/classification |
| `embeddingModel` | `google/text-embedding-004` | Model for vector embeddings |
| `mem0UserId` | `default` | Mem0 user scope |
| `maxRecallChunks` | `10` | Max memories returned per search |
| `maxRecallTokens` | `1500` | Token budget for recalled memories |
| `autoExtract` | `true` | Auto-extract memories after conversations |
| `autoMaintain` | `true` | Run consolidation at session start |

### Mem0 (optional)

If using Mem0 cloud extraction, set the API key as an environment variable:

```bash
export MEM0_API_KEY="your-key-here"
```

Then set `extractionProvider` to `mem0` or `both`.

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
| `memory_mem0_sync` | Sync Mem0 cloud memories to local (optional) |

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
├── SESSION-STATE.md     # Hot RAM scratchpad
└── lance/               # LanceDB tables
    ├── chunks.lance/    # Memory chunks with embeddings
    ├── daily_logs.lance/# Daily extraction logs
    └── rules.lance/     # Procedural rules
```

## Security

### Network calls
This plugin makes outbound requests to exactly two services:
- **Your configured model provider** (via OpenClaw runtime) — LLM completions and embeddings
- **Mem0** (via `mem0ai` npm package) — only when `extractionProvider` is `mem0` or `both`

No other endpoints are contacted. No telemetry or analytics.

### API keys
- LLM calls use your existing OpenClaw model provider — no extra API key needed
- `MEM0_API_KEY` — optional, only needed if using Mem0 cloud extraction, set as environment variable

### Prompt injection
When enabled (default), the plugin automatically injects recalled memories into the system prompt. To disable:
```json
{ "config": { "autoExtract": false, "autoMaintain": false } }
```

### Local storage
Memories and rules are stored locally in `~/.openclaw/smart-memory/lance/`. No memory content is sent anywhere except to your configured model provider and optionally Mem0.

## License

MIT
