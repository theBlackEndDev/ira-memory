// HTTP adapter exposing Friday-style memory API on 127.0.0.1:7775.
// Maps /memory/* + /conversation/* onto ira-memory's Postgres store.
// Keeps /entity/* and /kv/* in a bun:sqlite sidecar so ira-memory's
// Prisma schema stays untouched.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "./client.js";
import { store, storeMessage, openSession, forget } from "./store.js";
import { recall, textSearch, listFacts } from "./recall.js";
import { deriveProjectSlug } from "./summarize.js";
import type { MemoryCategory } from "./types.js";

const PORT = Number(process.env.MEMORY_API_PORT ?? 7775);
const HOST = process.env.MEMORY_API_HOST ?? "127.0.0.1";

// ─── Sidecar DB for entities + kv ───────────────────────────────
const sidecarDir = join(homedir(), ".claude");
mkdirSync(sidecarDir, { recursive: true });
const sidecar = new Database(join(sidecarDir, "memory-api-sidecar.db"));
sidecar.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── Friday memory type → ira-memory category ──────────────────
const TYPE_TO_CATEGORY: Record<string, MemoryCategory> = {
  user: "PREFERENCE",
  feedback: "LESSON",
  project: "PROJECT_STATE",
  reference: "CONTEXT",
};

// ─── Per-channel session cache (long-lived, one per channel) ───
const sessionCache = new Map<string, string>();

async function getOrCreateSession(channel: string): Promise<string> {
  const cached = sessionCache.get(channel);
  if (cached) return cached;

  // Reuse most recent open session for this channel, if any
  const existing = await prisma.session.findFirst({
    where: { channel, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    sessionCache.set(channel, existing.id);
    return existing.id;
  }

  const session = await openSession({
    channel,
    title: `${channel} conversation`,
    metadata: { source: "memory-api-7775", persistent: true },
  });
  sessionCache.set(channel, session.id);
  return session.id;
}

// ─── Helpers ────────────────────────────────────────────────────
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

const err = (msg: string, status = 400) => json({ error: msg }, status);

async function parseJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Resolve a project slug from explicit ?project=, X-Project header, or
// X-Cwd header (path containing /orchestrator/projects/<slug>/...).
// Returns null when no project context is available — callers must keep
// behavior un-filtered in that case for back-compat.
function resolveProject(req: Request, url: URL): string | null {
  const explicit = url.searchParams.get("project");
  if (explicit) return explicit;
  const headerSlug = req.headers.get("x-project");
  if (headerSlug) return headerSlug;
  const cwdHeader = req.headers.get("x-cwd");
  if (cwdHeader) return deriveProjectSlug(cwdHeader);
  return null;
}

function serializeFact(f: any) {
  const meta = (f.metadata ?? {}) as Record<string, unknown>;
  return {
    id: f.id,
    name: meta.name ?? null,
    type: meta.friday_type ?? f.category?.toLowerCase() ?? null,
    description: meta.description ?? null,
    content: f.content,
    category: f.category,
    tier: f.tier,
    tags: f.tags,
    created_at: f.createdAt,
    score: f.score,
  };
}

function serializeMessage(m: any) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    channel: m.session?.channel ?? null,
    created_at: m.createdAt,
  };
}

// ─── Route handler ──────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (method === "OPTIONS") return json({}, 204);

  try {
    // ── Health ──
    if (pathname === "/health") {
      return json({ status: "ok", backend: "ira-memory", port: PORT });
    }

    // ── Conversation ──
    if (pathname === "/conversation/log" && method === "POST") {
      const body = await parseJson(req);
      if (!body?.role || !body?.content) {
        return err("role and content required");
      }
      const channel = body.channel ?? "unknown";
      const sessionId = await getOrCreateSession(channel);
      const msg = await storeMessage({
        sessionId,
        role: body.role,
        content: body.content,
        metadata: body.metadata,
      });
      return json({ id: msg.id, session_id: sessionId });
    }

    if (pathname === "/conversation/recent" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 200);
      const channel = url.searchParams.get("channel");
      const project = resolveProject(req, url);
      const sessionFilter: Record<string, unknown> = {};
      if (channel) sessionFilter.channel = channel;
      if (project) {
        sessionFilter.metadata = {
          path: ["cwd"],
          string_contains: `/projects/${project}`,
        };
      }
      const messages = await prisma.message.findMany({
        where: Object.keys(sessionFilter).length ? { session: sessionFilter } : {},
        include: { session: { select: { channel: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return json({ messages: messages.map(serializeMessage) });
    }

    if (pathname === "/conversation/search" && method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) return err("q required");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 200);
      const result = await textSearch({ query: q, tables: ["messages"], limit });
      // Attach channel info
      const ids = result.messages.map((m) => m.id);
      const withSession = ids.length
        ? await prisma.message.findMany({
            where: { id: { in: ids } },
            include: { session: { select: { channel: true } } },
          })
        : [];
      return json({ messages: withSession.map(serializeMessage) });
    }

    // ── Memory facts ──
    if (pathname === "/memory" && method === "POST") {
      const body = await parseJson(req);
      if (!body?.content) return err("content required");
      const fridayType = (body.type ?? "user").toLowerCase();
      const category = TYPE_TO_CATEGORY[fridayType] ?? "CONTEXT";
      // Resolve project from body.project, X-Project header, or X-Cwd header.
      const project =
        (typeof body.project === "string" && body.project) ||
        resolveProject(req, url);
      const extraTags = project ? [`project:${project}`] : [];
      // Prepend [slug] to content so FTS/semantic queries on the slug also
      // match this fact — matches summarize.ts behavior for auto-summary facts.
      const content =
        project && !body.content.startsWith(`[${project}]`)
          ? `[${project}] ${body.content}`
          : body.content;
      const fact = await store({
        category,
        tier: "LONG_TERM",
        content,
        source: "explicit",
        tags: [`friday:${fridayType}`, ...extraTags, ...(body.tags ?? [])],
        metadata: {
          name: body.name,
          description: body.description,
          friday_type: fridayType,
          ...(project ? { project } : {}),
        },
      });
      return json(serializeFact(fact));
    }

    if (pathname === "/memory/list" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
      const project = resolveProject(req, url);
      const result = await listFacts({
        limit,
        ...(project && { tags: [`project:${project}`] }),
      });
      return json({
        facts: result.facts.map(serializeFact),
        total: result.total,
      });
    }

    if (pathname === "/memory/recall" && method === "GET") {
      const topic = url.searchParams.get("topic") ?? undefined;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      // Explicit project (?project= / X-Project) is a deliberate hard scope (e.g. resume).
      // A project DERIVED from the caller's cwd (X-Cwd) is ambient — boost, don't filter,
      // so a sparse/new project still gets a useful recall instead of nothing.
      const explicitProject = url.searchParams.get("project") ?? req.headers.get("x-project");
      const cwdProject = !explicitProject ? deriveProjectSlug(req.headers.get("x-cwd")) : null;
      const result = await recall({
        query: topic,
        limit,
        ...(explicitProject && { tags: [`project:${explicitProject}`] }),
        ...(cwdProject && { boostTags: [`project:${cwdProject}`] }),
      });
      return json({
        facts: result.facts.map(serializeFact),
        summaries: result.summaries.map((s) => ({
          id: s.id,
          scope: s.scope,
          content: s.content,
          period_start: s.periodStart,
        })),
      });
    }

    if (pathname === "/memory/search" && method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) return err("q required");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const project = resolveProject(req, url);
      const result = await textSearch({ query: q, tables: ["facts"], limit });
      // textSearch doesn't natively filter by tag — post-filter when project
      // is set so the contract is still "project-scoped or nothing".
      const facts = project
        ? result.facts.filter((f) => f.tags?.includes(`project:${project}`))
        : result.facts;
      return json({ facts: facts.map(serializeFact) });
    }

    const memoryIdMatch = pathname.match(/^\/memory\/([^/]+)$/);
    if (memoryIdMatch && method === "DELETE") {
      const id = memoryIdMatch[1];
      if (id === "list" || id === "recall" || id === "search") {
        return err("not found", 404);
      }
      await forget(id);
      return json({ id, archived: true });
    }

    // ── Entities (sidecar) ──
    if (pathname === "/entity" && method === "POST") {
      const body = await parseJson(req);
      if (!body?.name || !body?.type) return err("name and type required");
      const stmt = sidecar.query(
        "INSERT INTO entities (name, type, details) VALUES (?, ?, ?) RETURNING id"
      );
      const row = stmt.get(
        body.name,
        body.type,
        body.details ? JSON.stringify(body.details) : null
      ) as { id: number };
      return json({ id: row.id, name: body.name, type: body.type });
    }

    if (pathname === "/entity/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const rows = sidecar
        .query(
          "SELECT id, name, type, details, created_at FROM entities WHERE name LIKE ? OR type LIKE ? ORDER BY id DESC LIMIT 100"
        )
        .all(`%${q}%`, `%${q}%`) as any[];
      return json({
        entities: rows.map((r) => ({
          ...r,
          details: r.details ? JSON.parse(r.details) : null,
        })),
      });
    }

    // ── KV (sidecar) ──
    const kvMatch = pathname.match(/^\/kv\/(.+)$/);
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]);
      if (method === "GET") {
        const row = sidecar
          .query("SELECT value FROM kv WHERE key = ?")
          .get(key) as { value: string } | null;
        if (!row) return err("not found", 404);
        return json({ key, value: JSON.parse(row.value) });
      }
      if (method === "PUT") {
        const body = await parseJson(req);
        const value = body?.value !== undefined ? body.value : body;
        sidecar
          .query(
            "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
              "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
          )
          .run(key, JSON.stringify(value));
        return json({ key, value });
      }
      if (method === "DELETE") {
        sidecar.query("DELETE FROM kv WHERE key = ?").run(key);
        return json({ key, deleted: true });
      }
    }

    return err("not found", 404);
  } catch (e: any) {
    console.error("[memory-api]", pathname, e);
    return err(e?.message ?? "internal error", 500);
  }
}

// ─── Start ──────────────────────────────────────────────────────
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: handle,
});

console.log(`[memory-api] listening on http://${server.hostname}:${server.port}`);
console.log(`[memory-api] backend: ira-memory (Postgres) + sidecar sqlite`);
