# IRA Memory

Database-backed conversation memory system for IRA / OpenClaw. Stores full conversation history, extracts durable memory facts, and supports structured + semantic retrieval across all sessions and channels.

## Architecture

```
Assistant (IRA / OpenClaw / Discord / Telegram / CLI)
        |
   ┌────┴─────────────────────────────┐
   │                                  │
   HTTP Memory API (127.0.0.1:7775)   Programmatic API
   /memory/* /conversation/*          store() / recall() / search() / summarize()
   /entity/* /kv/*                    │
   │                                  │
   └────┬─────────────────────────────┘
        |
  PostgreSQL 16 + pgvector + pg_trgm        +  bun:sqlite sidecar
   ├── sessions          append-only            ├── entities  (lightweight people/projects)
   ├── messages           append-only            └── kv        (cron state, flags)
   ├── memory_facts       curated knowledge
   ├── summaries          compacted views
   ├── *_embeddings       1536-dim vectors
   └── file_sync_records  file-import tracking
```

## Quick Start

```bash
# 1. Start the database
docker compose up -d

# 2. Create .env file
cp .env.example .env
# Edit .env to add your OPENAI_API_KEY

# 3. Install dependencies
bun install

# 4. Run migrations (first time only)
bunx prisma migrate dev

# 5. Verify
bun run src/cli.ts stats

# 6. (optional) Start the HTTP Memory API on 127.0.0.1:7775
bun run memory-api
```

## HTTP Memory API

`src/http-server.ts` exposes a single shared memory surface across every channel
(Discord, Telegram, CLI, webchat). Start it with:

```bash
bun run memory-api
# → [memory-api] listening on http://127.0.0.1:7775
```

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness check — returns `{status, backend, port}` |
| `/conversation/log` | POST | Append a message (`role`, `content`, `channel`) — auto-creates a long-lived per-channel session |
| `/conversation/recent` | GET | Latest messages — optional `?channel=` and `?limit=` |
| `/conversation/search` | GET | Full-text message search (`?q=`) |
| `/memory` | POST | Store a fact (`type` ∈ `user`/`feedback`/`project`/`reference`, `name`, `content`, `description`) |
| `/memory/list` | GET | List facts (`?limit=`) |
| `/memory/recall` | GET | Multi-layer recall (`?topic=`) |
| `/memory/search` | GET | Full-text fact search (`?q=`) |
| `/memory/<id>` | DELETE | Soft-archive a fact |
| `/entity` | POST | Create entity in sidecar (`name`, `type`, `details`) |
| `/entity/search` | GET | Search entities (`?q=`) |
| `/kv/<key>` | GET / PUT / DELETE | Scratch key-value (cron state, flags) |

Friday-style memory `type` is mapped to ira-memory categories at the boundary:
`user → PREFERENCE`, `feedback → LESSON`, `project → PROJECT_STATE`, `reference → CONTEXT`.

`/entity` and `/kv` use a `bun:sqlite` sidecar at `~/.claude/memory-api-sidecar.db`
so the Postgres schema stays clean.

Bind address and port are configurable via `MEMORY_API_HOST` / `MEMORY_API_PORT`.

## Claude Code Session Capture

Automatically capture all your Claude Code conversations into ira-memory.

### Install

```bash
bun run src/cli.ts install-hooks
```

This adds a `SessionEnd` hook to `~/.claude/settings.json`. Every time a Claude Code session ends, the full transcript is parsed and stored — including user prompts, assistant responses, session metadata, and auto-generated summaries.

### What gets captured

- All user and assistant messages (tool calls are excluded to reduce noise)
- Session metadata: working directory, timestamp, CC session ID
- Auto-generated summary via LLM on session close
- Auto-extracted learnings (decisions, mistakes, best practices)

### Manual capture

Import a specific transcript file:

```bash
bun run src/cli.ts capture --transcript ~/.claude/sessions/<id>/transcript.jsonl
```

### Verify

After a Claude Code session ends:

```bash
bun run src/cli.ts stats      # Check message/session counts
bun run src/cli.ts sessions    # List captured sessions
```

## Configuration

All config lives in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_DATABASE_URL` | PostgreSQL connection string | `postgresql://ira_memory:ira_memory_secret@localhost:5433/ira_memory` |
| `OPENAI_API_KEY` | Required for embeddings and summarization | — |
| `MEMORY_API_HOST` | HTTP API bind address | `127.0.0.1` |
| `MEMORY_API_PORT` | HTTP API port | `7775` |
| `IRA_BUN_PATH` | Absolute path to `bun` binary — only set when bun isn't at `~/.bun/bin/bun` (nvm/asdf/pnpm/nix). Used by `install-hooks` and `scripts/cron-maintain.sh`. | `~/.bun/bin/bun` |
| `IRA_BACKUP_DIR` | Directory for `backup` / `restore` pg_dump files | `<project>/backups` |
| `IRA_PROJECT_DIR` | Override project root for `scripts/cron-maintain.sh` | auto-resolved |
| `IRA_LOG_DIR` | Override log directory for `scripts/cron-maintain.sh` | `<project>/logs` |

The database runs as `ira-memory-db` via the local `docker-compose.yml` on port **5433** (not 5432, to avoid conflicts with other Postgres instances).

## CLI Reference

```
bun run src/cli.ts <command> [options]
```

### Core Operations

| Command | Description | Example |
|---------|-------------|---------|
| `store` | Store a memory fact | `store --category DECISION --content "Use pgvector for search" --tier LONG_TERM` |
| `list` | List facts with filters | `list --category TODO --tier DAILY --limit 10` |
| `forget` | Soft-archive a fact | `forget <fact-id>` |
| `delete` | Permanently delete a fact | `delete <fact-id>` |
| `sessions` | List conversation sessions | `sessions --limit 5` |
| `stats` | Show counts and breakdowns | `stats` |

### Search & Recall

| Command | Description | Example |
|---------|-------------|---------|
| `search` | Full-text search (PostgreSQL tsvector) | `search pgvector deployment` |
| `semantic` | Vector similarity search (pgvector) | `semantic "what tech stack do we use" --tables facts,messages` |
| `recall` | Multi-layer recall (structured + FTS + semantic) | `recall --query "auth decisions" --categories DECISION --since 2026-03-01` |

### Summarization

| Command | Description | Example |
|---------|-------------|---------|
| `summarize` | Generate a summary | `summarize --scope SESSION --session <id>` |
| | | `summarize --scope DAILY --date 2026-04-05` |
| | | `summarize --scope WEEKLY --date 2026-03-31` |
| | | `summarize --scope PROJECT --project the-forge` |
| `summarize-pending` | Process all sessions captured by the SessionEnd hook that haven't been summarized yet (off the hook hot path) | `summarize-pending` |

### Maintenance

| Command | Description | Example |
|---------|-------------|---------|
| `maintain` | Run tier promotion + expiration | `maintain` |
| `compact` | Truncate old messages, drop old embeddings | `compact --days 90` |
| `conflicts` | Detect contradictory facts | `conflicts --limit 20` |
| `threads` | Show cross-session threading chains | `threads` |
| `detect-sensitive` | Scan and auto-flag sensitive facts | `detect-sensitive` |

### Import / Export / Backup

| Command | Description | Example |
|---------|-------------|---------|
| `import` | Import from file-based memory | `import --memory-md /path/to/MEMORY.md --daily-dir /path/to/memory/` |
| `export` | Export as JSON or markdown | `export --format md` or `export --format json` |
| `backup` | Create a timestamped pg_dump | `backup` |
| `restore` | Restore from a pg_dump file | `restore ./backups/ira-memory-2026-04-06.sql` |
| `backfill` | Generate embeddings for unembedded items | `backfill --type facts --batch 50` |

Retroactively tag historical facts with `project:<slug>` based on the originating session's `cwd` (idempotent, no LLM, metadata-only):

```bash
bun run src/backfill-project-tags.ts --dry-run
bun run src/backfill-project-tags.ts --project faceless-youtube
```

### Learning loop

| Command | Description | Example |
|---------|-------------|---------|
| `learn` | Record session ratings + auto-extracted lessons | `learn --session <id> --rating 8` |
| `discover` | Mine repeated patterns across sessions into PREFERENCE/LESSON facts | `discover --since 2026-04-01` |
| `synthesize` | Roll up related facts into higher-confidence consolidated facts | `synthesize --tag project:the-forge` |

### Categories and Tiers

**Categories:** `PREFERENCE`, `DECISION`, `PLAN`, `TODO`, `FACT`, `LESSON`, `CHECKPOINT`, `CONTEXT`, `TOOL_CONFIG`, `PROJECT_STATE`

**Tiers:**
- `SHORT_TERM` -- expires after 48h unless promoted (default for new facts)
- `DAILY` -- weekly rolling window
- `LONG_TERM` -- persistent, never auto-deleted

Tier promotion runs via `maintain`:
```
SHORT_TERM ──(48h, confidence >= 0.7)──> DAILY ──(7d)──> LONG_TERM
SHORT_TERM ──(48h, low confidence)──> archived
```

## Programmatic API

```typescript
import {
  openSession, closeSession, storeMessage, store,
  recall, textSearch, semanticSearch,
  summarize, promoteAndExpire, detectConflicts,
  exportAll, exportMarkdown, backup, restore,
  importFromFiles, prisma,
} from "./src/index.js";

// Open a session
const session = await openSession({ channel: "cli", title: "My Session" });

// Store messages
await storeMessage({ sessionId: session.id, role: "user", content: "Hello" });
await storeMessage({ sessionId: session.id, role: "assistant", content: "Hi there" });

// Store a fact (auto-embeds, auto-detects sensitive content)
await store({
  category: "DECISION",
  content: "We chose PostgreSQL over SQLite for the memory system",
  tier: "LONG_TERM",
  source: "explicit",
  tags: ["infrastructure"],
});

// Recall with multi-layer search (structured + FTS + semantic)
const results = await recall({
  query: "database choice",
  categories: ["DECISION"],
  limit: 10,
});

// Pure semantic search
const similar = await semanticSearch({
  query: "what database are we using",
  tables: ["facts", "summaries"],
  threshold: 0.4,
});

// Close session (auto-generates summary via LLM)
const { summary } = await closeSession(session.id);
```

## Retrieval Strategy

Recall executes a four-layer stack and merges results by score:

| Layer | Method | When Used |
|-------|--------|-----------|
| 1. Exact Lookup | SQL by ID | Direct session/fact references |
| 2. Structured Filter | SQL WHERE | Category, tier, time range, tags |
| 3. Full-Text Search | tsvector/tsquery | Keyword queries |
| 4. Semantic Search | pgvector cosine similarity | Free-form natural language |

Scoring formula:
```
score = 0.3 * recency + 0.4 * relevance + 0.2 * tier_weight + 0.1 * confidence
```

## Data Flow

```
1. User sends message
   ├── storeMessage() writes to DB
   └── embedMessageAsync() queues embedding (non-blocking)

2. Assistant responds
   ├── storeMessage() writes to DB
   └── Detects facts → store() with auto-embed + auto-sensitive-detect

3. Session ends
   ├── closeSession() sets endedAt
   └── summarize(SESSION) generates LLM summary + extracts facts

4. Daily/weekly maintenance
   ├── summarize(DAILY) rolls up session summaries
   ├── summarize(WEEKLY) rolls up daily summaries
   └── promoteAndExpire() manages tier lifecycle
```

## Privacy Model

Single-user, unified memory pool. All channels (CLI, webchat, Telegram, Discord) share one memory space with no access isolation.

- `session.channel` is metadata for filtering, not an access boundary
- `isSensitive` auto-flags API keys, passwords, tokens, SSNs, credit card numbers
- Sensitive facts are excluded from `exportMarkdown()` and LLM-generated summaries
- Sensitive facts remain queryable directly by the user
- `forget()` soft-archives; `hardDelete()` permanently removes fact + embedding

## File Structure

```
ira-memory/
├── prisma/
│   ├── schema.prisma                Full data model
│   └── migrations/                  Prisma + custom SQL migrations
├── src/
│   ├── index.ts                     Public API barrel export
│   ├── types.ts                     TypeScript interfaces
│   ├── client.ts                    Prisma client singleton
│   ├── store.ts                     Write operations (sessions, messages, facts)
│   ├── recall.ts                    Multi-layer recall (structured + FTS + semantic)
│   ├── search.ts                    Semantic vector search (pgvector)
│   ├── embed.ts                     Embedding generation + backfill (OpenAI)
│   ├── summarize.ts                 LLM summarization — auto-tags facts with project:<slug> derived from session cwd
│   ├── maintain.ts                  Tier promotion, expiration, conflict detection, compaction
│   ├── export.ts                    JSON/markdown export, pg_dump backup/restore, sensitive detection
│   ├── import.ts                    File-based memory parser (MEMORY.md, daily/*.md)
│   ├── cli.ts                       CLI interface
│   ├── cc-capture.ts                Claude Code SessionEnd hook (write-only fast path)
│   ├── hook-bridge.ts               Subcommand router for Claude Code hooks (recall-context is project-aware)
│   ├── http-server.ts               HTTP Memory API on 127.0.0.1:7775 (Postgres + sqlite sidecar)
│   ├── learn.ts                     Session ratings + lesson extraction
│   ├── discover.ts                  Cross-session pattern mining
│   ├── synthesize.ts                Fact consolidation
│   ├── backfill-project-tags.ts     Retroactively tag facts with project:<slug>
│   ├── test-e2e.ts                  End-to-end test suite (28 assertions)
│   └── test-flow.ts                 Integration smoke test
├── scripts/
│   └── cron-maintain.sh             Hourly maintain + summarize-pending + embedding backfill
├── backups/                         pg_dump backup files (gitignored)
├── logs/                            cron output (gitignored)
├── .env                             Database URL + OpenAI key
├── docker-compose.yml               Postgres 16 + pgvector container
├── package.json
└── tsconfig.json
```

## Project-Scoped Recall

When a Claude Code session originates inside `<...>/orchestrator/projects/<slug>/`,
the slug is auto-derived from `session.metadata.cwd` and:

1. Facts extracted by session summarization are tagged `project:<slug>`.
2. Their content is prefixed with `[<slug>]` so FTS/semantic queries match the slug.
3. The `recall-context` hook runs a two-pass merge — strict (tag filter) + loose
   (slug as query) — and dedups by id, so older untagged facts are still surfaced.

To retag historical data after a deploy, run `bun run src/backfill-project-tags.ts`.
Project-less callers stay global — back-compatible with everything that doesn't
pass a project slug.

## Migration from File-Based Memory

The system coexists with the existing file-based memory (`MEMORY.md`, `memory/*.md`). Migration is incremental:

| Phase | Files | Database |
|-------|-------|----------|
| **0: Coexist** (current) | Read/write | Write-only (messages + facts) |
| 1: Import | Read-only source | Import files as facts |
| 2: Dual-write | Write continues | Read primary, file fallback |
| 3: DB-primary | Read-only exports | Authoritative |

Import existing memory:
```bash
bun run src/cli.ts import
```

Rollback at any phase: files are never modified or deleted.

## Infrastructure

The database is a Docker container defined in `docker-compose.yml`:

- **Image:** `pgvector/pgvector:pg16` (PostgreSQL 16 + pgvector extension)
- **Port:** 5433 (mapped from container 5432)
- **Extensions:** `vector` (pgvector), `pg_trgm` (trigram fuzzy search)
- **Indexes:** HNSW on all embedding tables, GIN on tsvector columns, GIN on trigram columns

## Testing

```bash
# Integration smoke test
bun run src/test-flow.ts

# Full E2E test suite (requires running DB + OpenAI key)
bun run src/test-e2e.ts
```

The E2E suite tests 28 assertions across all phases: CRUD, embeddings, semantic search, summarization, tier management, sensitive detection, export, and compaction.
