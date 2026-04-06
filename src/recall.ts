import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { semanticSearch } from "./search.js";
import type {
  RecallInput,
  RecallResult,
  TextSearchInput,
  TextSearchResult,
  ListFactsInput,
  MemoryFact,
  Summary,
  Message,
} from "./types.js";

// ─── Recall: structured + FTS combined ──────────────────────────

export async function recall(input: RecallInput): Promise<RecallResult> {
  const limit = input.limit ?? 20;

  // Layer 2: Structured filter on facts
  const factWhere: Prisma.MemoryFactWhereInput = {
    isArchived: false,
    ...(input.categories && { category: { in: input.categories } }),
    ...(input.tier && { tier: input.tier }),
    ...(input.tags?.length && { tags: { hasSome: input.tags } }),
    ...(input.timeRange && {
      createdAt: {
        ...(input.timeRange.after && { gte: input.timeRange.after }),
        ...(input.timeRange.before && { lte: input.timeRange.before }),
      },
    }),
  };

  const facts = await prisma.memoryFact.findMany({
    where: factWhere,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  // Layer 2: Structured filter on summaries
  const summaryWhere: Prisma.SummaryWhereInput = {
    ...(input.sessionId && { sessionId: input.sessionId }),
    ...(input.timeRange && {
      periodStart: {
        ...(input.timeRange.after && { gte: input.timeRange.after }),
        ...(input.timeRange.before && { lte: input.timeRange.before }),
      },
    }),
  };

  const summaries = await prisma.summary.findMany({
    where: summaryWhere,
    orderBy: { periodStart: "desc" },
    take: limit,
  });

  // Layer 3: If query provided, also do FTS and merge
  let ftsFactIds = new Set<string>();
  if (input.query) {
    const tsQuery = input.query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^\w]/g, ""))
      .filter(Boolean)
      .join(" & ");

    if (tsQuery) {
      const ftsFacts = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
        SELECT id, ts_rank(content_tsv, to_tsquery('english', ${tsQuery})) as rank
        FROM memory_facts
        WHERE content_tsv @@ to_tsquery('english', ${tsQuery})
          AND is_archived = false
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
      ftsFacts.forEach((f) => ftsFactIds.add(f.id));

      // Fetch full facts for FTS results not already in structured results
      const existingIds = new Set(facts.map((f) => f.id));
      const newIds = ftsFacts
        .map((f) => f.id)
        .filter((id) => !existingIds.has(id));

      if (newIds.length > 0) {
        const additionalFacts = await prisma.memoryFact.findMany({
          where: { id: { in: newIds } },
        });
        facts.push(...additionalFacts);
      }
    }
  }

  // Layer 4: Semantic search if query provided and we have few results
  let semanticFactIds = new Set<string>();
  if (input.query && facts.length < limit) {
    try {
      const semanticResults = await semanticSearch({
        query: input.query,
        tables: ["facts", "summaries"],
        limit: limit - facts.length,
        threshold: 0.3,
      });

      const existingIds = new Set(facts.map((f) => f.id));
      for (const sf of semanticResults.facts) {
        if (!existingIds.has(sf.id)) {
          facts.push(sf);
          semanticFactIds.add(sf.id);
        }
      }

      const existingSummaryIds = new Set(summaries.map((s) => s.id));
      for (const ss of semanticResults.summaries) {
        if (!existingSummaryIds.has(ss.id)) {
          summaries.push(ss);
        }
      }
    } catch {
      // Semantic search failure is non-fatal (embedding API may be down)
    }
  }

  // Score and sort facts
  const now = Date.now();
  const scoredFacts = facts.map((fact) => {
    const daysAgo = (now - fact.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const recency = 1.0 / (1.0 + daysAgo * 0.1);
    const tierWeight =
      fact.tier === "LONG_TERM" ? 1.0 : fact.tier === "DAILY" ? 0.6 : 0.3;
    const relevance = ftsFactIds.has(fact.id) ? 1.0 : semanticFactIds.has(fact.id) ? 0.8 : 0.5;

    const score =
      0.3 * recency + 0.4 * relevance + 0.2 * tierWeight + 0.1 * fact.confidence;

    return { ...fact, score };
  });

  scoredFacts.sort((a, b) => b.score - a.score);

  // Score summaries (simple recency)
  const scoredSummaries = summaries.map((s) => {
    const daysAgo =
      (now - s.periodStart.getTime()) / (1000 * 60 * 60 * 24);
    const score = 1.0 / (1.0 + daysAgo * 0.1);
    return { ...s, score };
  });

  // Optionally include raw messages
  let messages: Array<Message & { score: number }> | undefined;
  if (input.includeMessages) {
    const msgWhere: Prisma.MessageWhereInput = {
      ...(input.sessionId && { sessionId: input.sessionId }),
      ...(input.channel && {
        session: { channel: input.channel },
      }),
      ...(input.timeRange && {
        createdAt: {
          ...(input.timeRange.after && { gte: input.timeRange.after }),
          ...(input.timeRange.before && { lte: input.timeRange.before }),
        },
      }),
    };

    const rawMessages = await prisma.message.findMany({
      where: msgWhere,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    messages = rawMessages.map((m) => {
      const daysAgo = (now - m.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      return { ...m, score: 1.0 / (1.0 + daysAgo * 0.1) };
    });
  }

  return {
    facts: scoredFacts.slice(0, limit),
    summaries: scoredSummaries.slice(0, limit),
    messages,
  };
}

// ─── Full-text search ───────────────────────────────────────────

export async function textSearch(input: TextSearchInput): Promise<TextSearchResult> {
  const limit = input.limit ?? 20;
  const tables = input.tables ?? ["facts", "messages"];

  const tsQuery = input.query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^\w]/g, ""))
    .filter(Boolean)
    .join(" & ");

  if (!tsQuery) {
    return { facts: [], messages: [] };
  }

  let facts: Array<MemoryFact & { rank: number }> = [];
  let messages: Array<Message & { rank: number }> = [];

  if (tables.includes("facts")) {
    const rawFacts = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
      SELECT id, ts_rank(content_tsv, to_tsquery('english', ${tsQuery})) as rank
      FROM memory_facts
      WHERE content_tsv @@ to_tsquery('english', ${tsQuery})
        AND is_archived = false
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    if (rawFacts.length > 0) {
      const fullFacts = await prisma.memoryFact.findMany({
        where: { id: { in: rawFacts.map((f) => f.id) } },
      });

      const rankMap = new Map(rawFacts.map((f) => [f.id, f.rank]));
      facts = fullFacts
        .map((f) => ({ ...f, rank: rankMap.get(f.id) ?? 0 }))
        .sort((a, b) => b.rank - a.rank);
    }
  }

  if (tables.includes("messages")) {
    const rawMessages = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
      SELECT id, ts_rank(content_tsv, to_tsquery('english', ${tsQuery})) as rank
      FROM messages
      WHERE content_tsv @@ to_tsquery('english', ${tsQuery})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    if (rawMessages.length > 0) {
      const fullMessages = await prisma.message.findMany({
        where: { id: { in: rawMessages.map((m) => m.id) } },
      });

      const rankMap = new Map(rawMessages.map((m) => [m.id, m.rank]));
      messages = fullMessages
        .map((m) => ({ ...m, rank: rankMap.get(m.id) ?? 0 }))
        .sort((a, b) => b.rank - a.rank);
    }
  }

  return { facts, messages };
}

// ─── List facts ─────────────────────────────────────────────────

export async function listFacts(
  input?: ListFactsInput
): Promise<{ facts: MemoryFact[]; total: number }> {
  const where: Prisma.MemoryFactWhereInput = {
    ...(input?.includeArchived ? {} : { isArchived: false }),
    ...(input?.category && { category: input.category }),
    ...(input?.tier && { tier: input.tier }),
  };

  const [facts, total] = await Promise.all([
    prisma.memoryFact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: input?.limit ?? 50,
      skip: input?.offset ?? 0,
    }),
    prisma.memoryFact.count({ where }),
  ]);

  return { facts, total };
}
