# Smart Memory Manager for OpenClaw

An intelligent memory skill for [OpenClaw](https://openclaw.ai) that replaces manual memory curation with automatic extraction, hybrid search, and cognitive-science-inspired memory lifecycle management.

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

## Requirements

- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key (for local extraction and search)
- Optional: a [Mem0](https://mem0.ai) API key (for cloud extraction)

## Installation

### From ClawHub

```bash
openclaw skills install onenomadllc/smart-memory
```

### Manual install

1. Clone the repository:
   ```bash
   git clone https://github.com/onenomadllc/openclaw-smart-memory.git
   ```

2. Install dependencies and build:
   ```bash
   cd openclaw-smart-memory
   npm install
   npm run build
   ```

3. Copy or symlink into an OpenClaw skills directory:
   ```bash
   # Option A: Copy to workspace skills
   cp -r openclaw-smart-memory ~/.openclaw/workspace/skills/smart-memory

   # Option B: Symlink (for development)
   ln -s "$(pwd)" ~/.openclaw/workspace/skills/smart-memory

   # Option C: Windows symlink (run as admin or enable Developer Mode)
   mklink /J "%USERPROFILE%\.openclaw\workspace\skills\smart-memory" "%CD%"
   ```

   The skill can be placed in any of OpenClaw's skill discovery locations:
   - `<workspace>/skills/` (highest priority)
   - `<workspace>/.agents/skills/`
   - `~/.agents/skills/`
   - `~/.openclaw/skills/`

4. Set your API key:
   ```bash
   # Linux/macOS — add to ~/.bashrc, ~/.zshrc, or ~/.profile
   export OPENROUTER_API_KEY="sk-or-your-key-here"

   # Windows — set as system/user environment variable
   setx OPENROUTER_API_KEY "sk-or-your-key-here"
   ```

5. Verify the installation:
   ```bash
   node ~/.openclaw/workspace/skills/smart-memory/dist/cli.js stats
   ```

## Quick Start

All commands use `node dist/cli.js` from the skill directory. Examples below assume the skill is installed at `~/.openclaw/workspace/skills/smart-memory`.

```bash
SM="node ~/.openclaw/workspace/skills/smart-memory/dist/cli.js"
```

### Ingest a memory (WAL — write-ahead)
```bash
$SM ingest "User prefers TypeScript over Python" --type preference --importance 0.7
```

### Extract memories from a conversation
```bash
# From a JSON file of [{role: "user", content: "..."}, ...]
$SM extract conversation.json my-session-id

# From stdin
cat conversation.json | $SM extract
```

### Search memories
```bash
$SM search "programming language preferences"
```

### Format for system prompt
```bash
$SM format "what should I know about this user"
```

Output:
```
--- RECALLED MEMORIES ---
## How this user works
- Always show code before explanation

## Known facts
- [preference] User prefers TypeScript over Python

## Recent context
- User was debugging OAuth integration yesterday
```

### Run maintenance
```bash
$SM maintain
```

### Manage session state
```bash
$SM session task "Building the auth module"
$SM session context "Using JWT with refresh tokens"
$SM session decision "Chose Postgres over MongoDB"
$SM session show
```

### View stats
```bash
$SM stats
```

## Configuration

API keys are set as environment variables only (never written to disk):

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes (for local extraction) | LLM + embedding calls via OpenRouter |
| `MEM0_API_KEY` | Only for Mem0 features | Mem0 cloud extraction |

Non-secret settings are stored in `~/.openclaw/smart-memory/config.json`:

```bash
$SM config set extractionProvider both    # 'local', 'mem0', or 'both'
$SM config set cheapModel google/gemini-2.5-flash-lite-preview
$SM config set maxRecallChunks 15
$SM config check                          # Show resolved config
```

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionProvider` | `local` | `local`, `mem0`, or `both` |
| `cheapModel` | `google/gemini-2.5-flash-lite-preview` | LLM for extraction/classification |
| `embeddingModel` | `google/text-embedding-004` | Embedding model for vector search |
| `mem0UserId` | `default` | Mem0 user scope |
| `maxRecallChunks` | `10` | Max memories returned per search |
| `maxRecallTokens` | `1500` | Token budget for recalled memories |

## Commands Reference

### Core
| Command | Description |
|---------|-------------|
| `extract [file] [convId]` | Extract memories from conversation JSON |
| `search <query>` | Hybrid ANN vector + keyword search |
| `format <query>` | Format memories for system prompt injection |
| `maintain` | Run consolidation (decay, promote, link, merge) |
| `stats` | Show memory statistics |

### WAL (Write-Ahead Log)
| Command | Description |
|---------|-------------|
| `ingest <text> [--type T] [--importance N] [--tags a,b]` | Immediately persist a memory |

### Procedural Rules
| Command | Description |
|---------|-------------|
| `rules` | Show active procedural rules |
| `rules extract [file]` | Extract rules from conversation |

### Feedback Loop
| Command | Description |
|---------|-------------|
| `outcome <helpful\|corrected\|irrelevant> <id...>` | Record recall outcome |

### Mem0 Cloud
| Command | Description |
|---------|-------------|
| `mem0 extract [file] [convId]` | Extract via Mem0 + sync to local |
| `mem0 search <query>` | Search Mem0 cloud |
| `mem0 sync` | Sync all Mem0 memories to local LanceDB |

### Session State
| Command | Description |
|---------|-------------|
| `session show` | Show current session state |
| `session task <text>` | Set current task |
| `session context <info>` | Add key context |
| `session decision <text>` | Record a decision |
| `session action <text>` | Add pending action |
| `session clear` | Clear session state |

### Config
| Command | Description |
|---------|-------------|
| `config get [key]` | Show saved settings |
| `config set <key> <value>` | Set a non-secret config value |
| `config check` | Show resolved config (keys shown as set/missing) |

## Integration with OpenClaw

### Post-conversation extraction
After each session, pipe conversation history through extraction:
```bash
$SM extract session-export.json
```

### WAL during conversations
Before responding to important user statements, capture immediately:
```bash
$SM ingest "User prefers dark mode" --type preference
```

### System prompt injection
Use `format` to recall relevant memories and inject into the system prompt alongside SOUL.md and other workspace files.

### Session state recovery
The `SESSION-STATE.md` file in `~/.openclaw/smart-memory/` is plain markdown. Inject it into the bootstrap to give the agent instant context after compaction or restart.

### Periodic maintenance
Run `maintain` daily via OpenClaw's cron skill to consolidate memories:
```bash
$SM maintain
```

## How It Works

### Architecture
```
Conversations ──> Extract ──> LanceDB (vectors + metadata)
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
               Vector ANN   Keyword Match   Graph Walk
                    │             │             │
                    └─────────────┼─────────────┘
                                  │
                           Score + Rank
                                  │
                         Token Budget Cap
                                  │
                       Format for Prompt
```

### Memory Tiers
```
daily (2d) ──> short-term (14d) ──> long-term (90d) ──> archive
                    ▲                                       │
                    └───── reactivation (recalled) ─────────┘
```

### Cognitive Layers
- **Episodic** — events tied to a moment ("user debugged OAuth yesterday")
- **Semantic** — enduring facts ("user prefers TypeScript")
- **Procedural** — behavioral rules ("always show code before explanation")

### Spreading Activation
Based on Collins & Loftus (1975). When top-scoring memories are found, the system walks their graph edges to discover related memories not directly matching the query. Two hops deep, with activation decaying at each hop.

## Data Storage

All data lives in `~/.openclaw/smart-memory/`:
```
~/.openclaw/smart-memory/
├── config.json          # Non-secret settings
├── SESSION-STATE.md     # Hot RAM scratchpad
└── lance/               # LanceDB tables
    ├── chunks.lance/    # Memory chunks with embeddings
    ├── daily_logs.lance/# Daily extraction logs
    └── rules.lance/     # Procedural rules
```

## License

MIT
