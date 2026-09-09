#!/usr/bin/env bun
/**
 * pi-capture.ts — imports a pi session's JSONL transcript into ira-memory.
 *
 * Sibling to cc-capture.ts, same spine (parse → extract → dedup → store),
 * different source format. See ~/Projects/Plans/pi-ira-memory-capture.md for
 * the design (§3.2A) and the phase this belongs to (Phase 1).
 *
 * Unlike cc-capture.ts (a one-shot SessionEnd hook fed a finished transcript),
 * this is called repeatedly against a *live, growing* file — once per
 * debounced `agent_settled`, and once more (with `final: true`) on
 * `session_shutdown`. Every entry write is idempotent on `metadata.piEntryId`,
 * so re-running against the same file only imports what's new.
 *
 * Scope: user + assistant text, thinking blocks dropped (plan D1 —
 * model-dependent, absent on Anthropic, restated in the visible answer).
 *
 * Phase 4 adds tool calls and tool results, each its own row:
 *   - a toolCall block inside an assistant message → role="assistant",
 *     toolName/toolInput set, content is a short capped marker
 *     (`→ name(args)`) so it's still FTS-searchable without being prose.
 *   - a toolResult session entry → role="tool", toolName/toolOutput set,
 *     content is the result text head-capped at IRA_PI_TOOLRESULT_CAP
 *     (default 2000 chars; p50 tool-result size in this codebase's own
 *     transcripts was 416 chars, so most results are stored in full).
 * Both are always `skipEmbed: true` (plan: "tool results never embedded" —
 * see store.ts). This is also where the one real secret found during Phase 3
 * backfill actually lived: an Anthropic session key sitting in a bash tool
 * RESULT, never in visible assistant prose. Tool content goes through the
 * exact same batched redaction as everything else, for exactly that reason.
 *
 * Redaction happens here, before storeMessage, which is also before
 * storeMessage's async embed call reads the row — so a redacted secret is
 * never sent to the embeddings API either. Engine chain (Phase 2):
 * betterleaks → gitleaks → heuristic (redact.ts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openSession, closeSession, storeMessage, store } from "./store.js";
import { extractDecisions } from "./decisions.js";
import { flushPendingEmbeds } from "./embed.js";
import { prisma } from "./client.js";
import { deriveProjectSlug } from "./summarize.js";
import { redactBatch } from "./redact.js";

/** Only files under here may be imported — the sync endpoint reads whatever path it's given. */
export const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface TextBlock { type: "text"; text: string }
interface ThinkingBlock { type: "thinking"; thinking?: string; text?: string }
/** Verified against a real session file: {type:"toolCall", id, name, arguments}. */
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments?: unknown }
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [k: string]: unknown };

interface AgentMessageLike {
  role?: string;
  content?: string | ContentBlock[];
}

/**
 * A toolResult session entry's message shape. Verified against a real
 * session file: {role:"toolResult", toolCallId, toolName, content:[{type:"text",...}], isError}.
 * Distinct from AgentMessageLike only in the extra toolName/isError fields.
 */
interface ToolResultMessageLike {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  content?: string | ContentBlock[];
  isError?: boolean;
}

interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessageLike;
}

interface OtherEntry {
  type: string;
  id: string;
  parentId: string | null;
  [k: string]: unknown;
}

type FileEntry = SessionHeader | SessionMessageEntry | OtherEntry;

export interface PiCaptureInput {
  sessionFile: string;
  /** Hint only — the session header's own `id` is authoritative. */
  sessionId?: string;
  /** Hint only — the session header's own `cwd` is authoritative when present. */
  cwd?: string;
  /** True on session_shutdown: marks the ira-memory session ended. */
  final?: boolean;
}

export interface PiCaptureResult {
  imported: number;
  skippedExisting: number;
  skippedEmpty: number;
  sessionRowId: string;
  project: string | null;
}

const MAX_MESSAGE_CHARS = Number(process.env.IRA_PI_MESSAGE_CAP ?? 50_000);
/** Shared cap for tool RESULT content and tool CALL arguments (plan Phase 4).
 * p50 tool-result size measured across this codebase's own sessions was 416
 * chars, so the default keeps most results whole while bounding the tail. */
const MAX_TOOLRESULT_CHARS = Number(process.env.IRA_PI_TOOLRESULT_CAP ?? 2_000);

/** Exported so http-server.ts can reject disallowed paths before doing any work. */
export function isSessionFileAllowed(path: string): boolean {
  const real = resolve(path);
  return real.startsWith(SESSIONS_ROOT + "/") || real === SESSIONS_ROOT;
}

function parseEntries(raw: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FileEntry);
    } catch {
      // A single malformed line (e.g. a torn write mid-append) must not
      // sink the whole sync — skip it and keep going.
    }
  }
  return entries;
}

/**
 * Extract visible text from a message's content: `text` blocks only.
 * `thinking` (D1, dropped) and `toolCall` (extracted separately, below) are
 * read past. Also used for toolResult entries — their content array carries
 * the same `{type:"text", text}` shape.
 */
function extractText(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextBlock).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.join("\n");
}

/** All `toolCall` blocks in an assistant message's content (Phase 4). */
function extractToolCalls(content: string | ContentBlock[] | undefined): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
      const b = block as ToolCallBlock;
      if (typeof b.id === "string" && typeof b.name === "string") calls.push(b);
    }
  }
  return calls;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function capText(text: string, max: number): { text: string; originalLength?: number } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), originalLength: text.length };
}

/**
 * Which entry ids lie on the current leaf path, walking backward from the
 * last entry in the file. Off-path entries (abandoned /branch subtrees,
 * edited-and-replaced messages) are still imported — just tagged
 * `metadata.offPath = true` and excluded from default recall (plan D3).
 *
 * The file is append-only from the active leaf forward, so "last entry in
 * the file" is the leaf at the moment of sync — true both for a live
 * debounced sync (called right after agent_settled advances the leaf) and
 * for a backfill import of a finished file.
 */
function onLeafPath(entries: FileEntry[]): Set<string> {
  const byId = new Map<string, FileEntry>();
  let last: FileEntry | undefined;
  for (const e of entries) {
    if (e.type === "session") continue;
    byId.set((e as { id: string }).id, e);
    last = e;
  }
  const onPath = new Set<string>();
  let cursor = last as { id: string; parentId: string | null } | undefined;
  while (cursor) {
    onPath.add(cursor.id);
    const parentId = cursor.parentId;
    cursor = parentId ? (byId.get(parentId) as typeof cursor) : undefined;
  }
  return onPath;
}

/**
 * Import whatever is new in `sessionFile` into ira-memory. Safe to call
 * repeatedly against the same growing file.
 */
export async function importPiSession(input: PiCaptureInput): Promise<PiCaptureResult> {
  if (!isSessionFileAllowed(input.sessionFile)) {
    throw new Error(`refusing to read outside ${SESSIONS_ROOT}: ${input.sessionFile}`);
  }

  const raw = readFileSync(input.sessionFile, "utf-8");
  const entries = parseEntries(raw);

  const header = entries.find((e): e is SessionHeader => e.type === "session");
  const piSessionId = header?.id ?? input.sessionId;
  const cwd = header?.cwd || input.cwd || "";
  if (!piSessionId) throw new Error(`no session id in header or input for ${input.sessionFile}`);

  const project = deriveProjectSlug(cwd);
  const onPath = onLeafPath(entries);

  // Find-or-create the ira-memory session row for this pi session.
  let sessionRow = await prisma.session.findFirst({
    where: { metadata: { path: ["piSessionId"], equals: piSessionId } },
  });
  if (!sessionRow) {
    sessionRow = await openSession({
      channel: "pi",
      title: project ? `pi:${project}` : "pi session",
      metadata: { piSessionId, cwd, project, sessionFile: input.sessionFile },
    });
  }
  const sessionRowId = sessionRow.id;

  // Fetch already-imported entry ids for this session once, not per-entry.
  const existing = await prisma.message.findMany({
    where: { sessionId: sessionRowId },
    select: { metadata: true },
  });
  const imported = new Set<string>();
  for (const m of existing) {
    const meta = m.metadata as Record<string, unknown> | null;
    const id = meta?.piEntryId;
    if (typeof id === "string") imported.add(id);
  }

  let skippedExisting = 0;
  let skippedEmpty = 0;

  // Pass 1: collect everything new. Redaction is batched (Phase 2, plan D4) —
  // one subprocess call for the whole sync, not one per message — so nothing
  // is stored until every candidate message's text is known.
  interface Pending {
    entryId: string;
    role: "user" | "assistant" | "tool";
    text: string;
    originalLength?: number;
    offPath?: true;
    toolName?: string;
    /** true for tool-call rows (content is redacted verbatim into toolInput too); false/undefined otherwise. */
    isToolCall?: true;
    /** for tool-result rows only — isError flag from the toolResult entry. */
    toolResultIsError?: boolean;
    skipEmbed?: true;
  }
  const pending: Pending[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry as SessionMessageEntry;
    const role = msg.message?.role;
    const entryOffPath = onPath.has(msg.id) ? undefined : true;

    if (role === "user" || role === "assistant") {
      if (!imported.has(msg.id)) {
        const text = extractText(msg.message?.content).trim();
        if (text) {
          const capped = capText(text, MAX_MESSAGE_CHARS);
          pending.push({ entryId: msg.id, role, text: capped.text, originalLength: capped.originalLength, offPath: entryOffPath });
        } else {
          skippedEmpty++;
        }
      } else {
        skippedExisting++;
      }

      // Tool calls live inside the assistant message's content array, not as
      // their own top-level entry, so each gets its own synthetic piEntryId
      // (`<msg.id>:call:<toolCallId>`) independent of whether the message's
      // own text row above was already imported in an earlier (pre-Phase-4)
      // sync of this same file.
      if (role === "assistant") {
        for (const call of extractToolCalls(msg.message?.content)) {
          const callEntryId = `${msg.id}:call:${call.id}`;
          if (imported.has(callEntryId)) {
            skippedExisting++;
            continue;
          }
          const argsCapped = capText(safeStringify(call.arguments), MAX_TOOLRESULT_CHARS);
          pending.push({
            entryId: callEntryId,
            role: "assistant",
            text: `\u2192 ${call.name}(${argsCapped.text})`,
            originalLength: argsCapped.originalLength,
            offPath: entryOffPath,
            toolName: call.name,
            isToolCall: true,
            skipEmbed: true,
          });
        }
      }
      continue;
    }

    if (role === "toolResult") {
      if (imported.has(msg.id)) {
        skippedExisting++;
        continue;
      }
      const tr = msg.message as unknown as ToolResultMessageLike;
      const text = extractText(tr.content).trim();
      if (!text) {
        skippedEmpty++;
        continue;
      }
      const capped = capText(text, MAX_TOOLRESULT_CHARS);
      pending.push({
        entryId: msg.id,
        role: "tool",
        text: capped.text,
        originalLength: capped.originalLength,
        offPath: entryOffPath,
        toolName: tr.toolName,
        toolResultIsError: tr.isError === true,
        skipEmbed: true,
      });
      continue;
    }
    // other roles (system, etc.) — ignored, same as before.
  }

  // Pass 2: one batched redaction call for every pending text — covers user
  // prose, assistant prose, tool-call arg previews, AND tool-result content
  // all in the same subprocess call. This is deliberate: the one real secret
  // found during Phase 3 backfill was sitting in a tool RESULT, not in
  // assistant prose (an Anthropic session key echoed by a bash command) —
  // redaction has to cover tool content or it covers nothing that matters.
  const batch = await redactBatch(pending.map((p) => p.text));

  // Pass 3: store, now that content is final.
  let importedCount = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const metadata: Record<string, unknown> = { piEntryId: p.entryId };
    if (p.offPath) metadata.offPath = true;
    if (batch.redacted[i]) {
      metadata.redacted = true;
      metadata.redactionEngine = batch.engine;
      metadata.redactionCount = batch.counts[i];
    }
    if (p.originalLength !== undefined) metadata.originalLength = p.originalLength;

    await storeMessage({
      sessionId: sessionRowId,
      role: p.role,
      content: batch.texts[i],
      toolName: p.toolName,
      // Reuse the already-redacted content string rather than redacting args a
      // second time independently — same safe value, structured column too.
      toolInput: p.isToolCall ? batch.texts[i] : undefined,
      toolOutput: p.toolResultIsError !== undefined ? { isError: p.toolResultIsError } : undefined,
      skipEmbed: p.skipEmbed,
      metadata,
    });
    importedCount++;
  }

  if (input.final) {
    // Unlike cc-capture.ts, this DOES run summarize (Phase 5). cc-capture
    // skips it because it's a short-lived hook subprocess Claude Code kills
    // before a 5-10s OpenAI summarization call can finish; pi-capture runs
    // inside ira-memory's own long-lived HTTP server process, so that kill
    // risk doesn't apply. `learn` (fact extraction) stays off — that's
    // Phase 6's decisions-extraction pass, a different prompt/purpose than
    // generic session summarization.
    const { summary } = await closeSession(sessionRowId, { summarize: true, learn: false });

    // Catch-all topic tags (plan D9): sessions filed under the `Projects`
    // root catch-all are otherwise only findable by date, since "Projects"
    // itself carries no subject information. Purely additive — the
    // `project:Projects` tag on the session is untouched; this creates a
    // small companion fact so the session becomes findable by subject too,
    // reusing the existing tag-search machinery (/memory/search, /memory/list)
    // rather than inventing a new one.
    if (project === "Projects" && summary?.keyTopics?.length) {
      const topics = summary.keyTopics.slice(0, 5);
      await store({
        category: "CONTEXT",
        content: `[Projects] Session topics: ${topics.join(", ")}`,
        tier: "SHORT_TERM",
        source: "inferred",
        tags: ["project:Projects", "pi:session-topic", ...topics.map((t) => `topic:${t}`)],
        metadata: { piSessionId, sessionRowId },
      });
    }

    // Decisions extraction (Phase 6) — the direct fix for the incident that
    // started this project: an audit agent flagged nine already-settled
    // decisions as open because nothing in memory distinguished LOCKED from
    // discussed-but-unresolved. Runs after summarize for the same
    // no-subprocess-kill-risk reason (long-lived server process, not a hook).
    if (project) {
      await extractDecisions({ sessionId: sessionRowId, project, minConfidence: 0.6, dedup: true });
    }
  }

  return {
    imported: importedCount,
    skippedExisting,
    skippedEmpty,
    sessionRowId,
    project,
  };
}

// ── CLI entry point, for manual/backfill use ────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const finalFlag = args.includes("--final");
  if (fileIdx === -1) {
    console.error("usage: bun run src/pi-capture.ts --file <path-to-session.jsonl> [--final]");
    process.exit(1);
  }
  importPiSession({ sessionFile: args[fileIdx + 1], final: finalFlag })
    .then((result) => {
      console.error(`[pi-capture] ${JSON.stringify(result)}`);
    })
    .catch((err) => {
      console.error(`[pi-capture] fatal: ${err}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      // storeMessage fires embeds async (fire-and-forget) — drain them before
      // the engine disconnects, or every embed silently fails mid-flight.
      // (This only matters for this CLI entry point; the HTTP server's
      // long-lived process never hits this path.)
      await flushPendingEmbeds();
      await prisma.$disconnect();
    });
}
