import OpenAI from "openai";
import { prisma } from "./client.js";

const openai = new OpenAI();
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 1536;

/**
 * Generate embedding for text via OpenAI API
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000), // Truncate to avoid token limits
  });
  return response.data[0].embedding;
}

/**
 * Embed a message and store in message_embeddings table.
 * Skips messages that are too short or pure tool output.
 */
export async function embedMessage(messageId: string): Promise<boolean> {
  try {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return false;
    if (message.content.length < 50) return false;
    if (message.role === "tool" && !message.toolName) return false;

    // Check if already embedded
    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM message_embeddings WHERE message_id = ${messageId} LIMIT 1
    `;
    if (existing.length > 0) return false;

    const vector = await generateEmbedding(message.content);
    const vectorStr = `[${vector.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO message_embeddings (id, message_id, vector, model, created_at)
      VALUES (${crypto.randomUUID()}, ${messageId}, ${vectorStr}::vector, ${EMBED_MODEL}, NOW())
      ON CONFLICT (message_id) DO NOTHING
    `;
    return true;
  } catch (err) {
    // Embedding failures must NOT block message storage (ISC-A-1)
    console.error(`[embed] Failed to embed message ${messageId}:`, err);
    return false;
  }
}

/**
 * Embed a memory fact and store in fact_embeddings table.
 */
export async function embedFact(factId: string): Promise<boolean> {
  try {
    const fact = await prisma.memoryFact.findUnique({ where: { id: factId } });
    if (!fact) return false;

    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM fact_embeddings WHERE fact_id = ${factId} LIMIT 1
    `;
    if (existing.length > 0) return false;

    const vector = await generateEmbedding(fact.content);
    const vectorStr = `[${vector.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO fact_embeddings (id, fact_id, vector, model, created_at)
      VALUES (${crypto.randomUUID()}, ${factId}, ${vectorStr}::vector, ${EMBED_MODEL}, NOW())
      ON CONFLICT (fact_id) DO NOTHING
    `;
    return true;
  } catch (err) {
    console.error(`[embed] Failed to embed fact ${factId}:`, err);
    return false;
  }
}

/**
 * Embed a summary and store in summary_embeddings table.
 */
export async function embedSummary(summaryId: string): Promise<boolean> {
  try {
    const summary = await prisma.summary.findUnique({ where: { id: summaryId } });
    if (!summary) return false;

    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM summary_embeddings WHERE summary_id = ${summaryId} LIMIT 1
    `;
    if (existing.length > 0) return false;

    const vector = await generateEmbedding(summary.content);
    const vectorStr = `[${vector.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO summary_embeddings (id, summary_id, vector, model, created_at)
      VALUES (${crypto.randomUUID()}, ${summaryId}, ${vectorStr}::vector, ${EMBED_MODEL}, NOW())
      ON CONFLICT (summary_id) DO NOTHING
    `;
    return true;
  } catch (err) {
    console.error(`[embed] Failed to embed summary ${summaryId}:`, err);
    return false;
  }
}

/**
 * Non-blocking embed: fires and forgets. Used in the write path.
 *
 * Each pending promise is tracked in `pendingEmbeds` so short-lived
 * processes (hooks, CLI commands) can `flushPendingEmbeds()` before
 * calling `prisma.$disconnect()`. Without this, the disconnect races
 * the unawaited embed calls and they fail with
 * "Response from the Engine was empty".
 */
const pendingEmbeds: Set<Promise<unknown>> = new Set();

function track<T>(p: Promise<T>): Promise<T> {
  pendingEmbeds.add(p);
  p.finally(() => pendingEmbeds.delete(p));
  return p;
}

export function embedMessageAsync(messageId: string): void {
  track(embedMessage(messageId).catch(() => false));
}

export function embedFactAsync(factId: string): void {
  track(embedFact(factId).catch(() => false));
}

export function embedSummaryAsync(summaryId: string): void {
  track(embedSummary(summaryId).catch(() => false));
}

/**
 * Await all in-flight async embed calls. Call this before `prisma.$disconnect()`
 * in short-lived processes to avoid engine-disconnect races.
 */
export async function flushPendingEmbeds(): Promise<void> {
  while (pendingEmbeds.size > 0) {
    await Promise.allSettled(Array.from(pendingEmbeds));
  }
}

/**
 * Backfill embeddings for all unembedded facts.
 * Returns count of newly embedded items.
 */
export async function backfillFactEmbeddings(
  batchSize: number = 50,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const unembedded = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT mf.id FROM memory_facts mf
    LEFT JOIN fact_embeddings fe ON fe.fact_id = mf.id
    WHERE fe.id IS NULL AND mf.is_archived = false
    ORDER BY mf.created_at DESC
  `;

  const total = unembedded.length;
  let done = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = unembedded.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((f) => embedFact(f.id))
    );
    done += results.filter((r) => r.status === "fulfilled" && r.value).length;
    onProgress?.(done, total);
  }

  return done;
}

/**
 * Backfill embeddings for all unembedded messages.
 */
export async function backfillMessageEmbeddings(
  batchSize: number = 50,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const unembedded = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM messages m
    LEFT JOIN message_embeddings me ON me.message_id = m.id
    WHERE me.id IS NULL AND LENGTH(m.content) >= 50 AND m.role != 'tool'
    ORDER BY m.created_at DESC
  `;

  const total = unembedded.length;
  let done = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = unembedded.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((m) => embedMessage(m.id))
    );
    done += results.filter((r) => r.status === "fulfilled" && r.value).length;
    onProgress?.(done, total);
  }

  return done;
}
