import { prisma } from "./client.js";
import { generateEmbedding } from "./embed.js";
import type { MemoryFact, Message, Summary } from "./types.js";

export interface SemanticSearchInput {
  query: string;
  tables?: Array<"facts" | "summaries" | "messages">;
  limit?: number;
  threshold?: number;
  channel?: string;
}

export interface SemanticSearchResult {
  facts: Array<MemoryFact & { similarity: number }>;
  summaries: Array<Summary & { similarity: number }>;
  messages: Array<Message & { similarity: number }>;
}

/**
 * Semantic search using pgvector cosine similarity.
 * Embeds the query, then searches across fact/summary/message embedding tables.
 */
export async function semanticSearch(
  input: SemanticSearchInput
): Promise<SemanticSearchResult> {
  const limit = input.limit ?? 10;
  const threshold = input.threshold ?? 0.3;
  const tables = input.tables ?? ["facts", "summaries"];

  const result: SemanticSearchResult = { facts: [], summaries: [], messages: [] };

  const queryVector = await generateEmbedding(input.query);
  if (!queryVector.length) return result; // embeddings disabled — recall falls back to FTS + structured
  const vectorStr = `[${queryVector.join(",")}]`;

  if (tables.includes("facts")) {
    const rawFacts = await prisma.$queryRaw<
      Array<{ fact_id: string; similarity: number }>
    >`
      SELECT fe.fact_id, 1 - (fe.vector <=> ${vectorStr}::vector) as similarity
      FROM fact_embeddings fe
      JOIN memory_facts mf ON mf.id = fe.fact_id
      WHERE mf.is_archived = false
        AND 1 - (fe.vector <=> ${vectorStr}::vector) > ${threshold}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    if (rawFacts.length > 0) {
      const facts = await prisma.memoryFact.findMany({
        where: { id: { in: rawFacts.map((r) => r.fact_id) } },
      });
      const simMap = new Map(rawFacts.map((r) => [r.fact_id, r.similarity]));
      result.facts = facts
        .map((f) => ({ ...f, similarity: simMap.get(f.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  if (tables.includes("summaries")) {
    const rawSummaries = await prisma.$queryRaw<
      Array<{ summary_id: string; similarity: number }>
    >`
      SELECT se.summary_id, 1 - (se.vector <=> ${vectorStr}::vector) as similarity
      FROM summary_embeddings se
      WHERE 1 - (se.vector <=> ${vectorStr}::vector) > ${threshold}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    if (rawSummaries.length > 0) {
      const summaries = await prisma.summary.findMany({
        where: { id: { in: rawSummaries.map((r) => r.summary_id) } },
      });
      const simMap = new Map(rawSummaries.map((r) => [r.summary_id, r.similarity]));
      result.summaries = summaries
        .map((s) => ({ ...s, similarity: simMap.get(s.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  if (tables.includes("messages")) {
    let rawMessages: Array<{ message_id: string; similarity: number }>;

    if (input.channel) {
      rawMessages = await prisma.$queryRaw`
        SELECT me.message_id, 1 - (me.vector <=> ${vectorStr}::vector) as similarity
        FROM message_embeddings me
        JOIN messages m ON m.id = me.message_id
        JOIN sessions s ON s.id = m.session_id
        WHERE 1 - (me.vector <=> ${vectorStr}::vector) > ${threshold}
          AND s.channel = ${input.channel}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    } else {
      rawMessages = await prisma.$queryRaw`
        SELECT me.message_id, 1 - (me.vector <=> ${vectorStr}::vector) as similarity
        FROM message_embeddings me
        WHERE 1 - (me.vector <=> ${vectorStr}::vector) > ${threshold}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    }

    if (rawMessages.length > 0) {
      const messages = await prisma.message.findMany({
        where: { id: { in: rawMessages.map((r) => r.message_id) } },
      });
      const simMap = new Map(rawMessages.map((r) => [r.message_id, r.similarity]));
      result.messages = messages
        .map((m) => ({ ...m, similarity: simMap.get(m.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  return result;
}
