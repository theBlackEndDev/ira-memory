import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { semanticSearch } from "./search.js";
import { generateEmbedding } from "./embed.js";
import type {
  RecallInput,
  RecallResult,
  TextSearchInput,
  TextSearchResult,
  ListFactsInput,
  MemoryFact,
  Summary,
  Message,
  RecallMessagesInput,
  RecallMessagesResult,
} from "./types.js";

/**
 * Ranking weights. Env-overridable so they can be swept by an eval harness against a second
 * instance (MEMORY_API_PORT) without editing source or bouncing the live service. The committed
 * defaults are the winners of that sweep — see scripts/eval-recall.ts.
 */
const W = {
  recency: Number(process.env.IRA_W_RECENCY ?? 0.15),
  relevance: Number(process.env.IRA_W_RELEVANCE ?? 0.6),
  tier: Number(process.env.IRA_W_TIER ?? 0.15),
  confidence: Number(process.env.IRA_W_CONFIDENCE ?? 0.1),
};

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

  // When a query is present this pass builds a CANDIDATE POOL, not the answer. Taking exactly
  // `limit` here pre-filled the result set with the newest facts before the query was ever
  // considered, so scoring only ever re-ordered the N most recent rows and relevance could not
  // pull an older fact in. Over-fetch and let the scoring pass below decide; the caller-visible
  // slice to `limit` happens at the return.
  const CANDIDATE_MULTIPLIER = 6;
  const candidateTake = input.query
    ? Math.min(limit * CANDIDATE_MULTIPLIER, 200)
    : limit;

  const facts = await prisma.memoryFact.findMany({
    where: factWhere,
    orderBy: { createdAt: "desc" },
    take: candidateTake,
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
  // ts_rank per matched fact, normalised to 0..1 against the strongest match in this result set.
  // Under OR semantics a fact matching one incidental word and a fact matching five both land in
  // ftsFactIds, so a boolean "did it match" flattens them to the same relevance. The rank is what
  // separates them, and it was being computed and discarded.
  const ftsRank = new Map<string, number>();
  if (input.query) {
    // OR, not AND. Joining terms with `&` required EVERY word to appear in a single fact, so any
    // natural-phrase recall ("terminal mouse tracking garbled output tmux") matched nothing and the
    // whole FTS layer silently no-opped. `|` lets partial matches through and leaves the ordering
    // to ts_rank, which already scores facts matching more terms higher.
    const tsQuery = input.query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^\w]/g, ""))
      .filter(Boolean)
      .join(" | ");

    if (tsQuery) {
      // Normalisation flag 1 divides the rank by 1 + log(document length). Without it, OR
      // semantics systematically favour long documents: a 1,800-char session digest matches more
      // incidental terms than a 90-char fact does, so verbose rows won every query regardless of
      // topic. Measured: this is what let novel-project facts top a query about shell escape codes.
      const ftsFacts = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
        SELECT id, ts_rank(content_tsv, to_tsquery('english', ${tsQuery}), 1) as rank
        FROM memory_facts
        WHERE content_tsv @@ to_tsquery('english', ${tsQuery})
          AND is_archived = false
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
      ftsFacts.forEach((f) => ftsFactIds.add(f.id));
      const maxRank = Math.max(...ftsFacts.map((f) => Number(f.rank) || 0), 0);
      if (maxRank > 0) {
        ftsFacts.forEach((f) => ftsRank.set(f.id, (Number(f.rank) || 0) / maxRank));
      }

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
  /** Absolute pgvector cosine similarity per fact, 0..1. Comparable across queries. */
  const semanticSim = new Map<string, number>();
  // Semantic layer — ON by default. This is the whole point of a pgvector store: it bridges the
  // vocabulary gaps full-text cannot, e.g. a query for "open database with no password" against a
  // fact that reads "unauthenticated Redis answered PING". Embedding runs through the OpenAI API,
  // which is metered but negligible at this volume and has always been how this store works.
  //
  // It was previously gated on `facts.length < limit`, which the structured pass above guaranteed
  // was never true — so the vector index sat unused since the store was built. Set
  // IRA_SEMANTIC_RECALL=0 to fall back to full-text only.
  if (input.query && process.env.IRA_SEMANTIC_RECALL !== "0") {
    try {
      // Over-fetch so candidates already pulled in by the structured/FTS passes also receive a
      // similarity score. Fetching only `limit` meant a fact could sit in the pool with no
      // semantic signal at all, and be ranked purely on how many common words it happened to share.
      const semanticResults = await semanticSearch({
        query: input.query,
        tables: ["facts", "summaries"],
        limit: candidateTake,
        threshold: 0.3,
      });

      const existingIds = new Set(facts.map((f) => f.id));
      for (const sf of semanticResults.facts) {
        // Cosine similarity is an ABSOLUTE measure of match quality, unlike the FTS rank which is
        // normalised within its own result set — there, the best hit always scores 1.0 even when
        // it only matched incidental words. Keep the real number and let scoring compare them.
        semanticSim.set(sf.id, (sf as { similarity?: number }).similarity ?? 0);
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
    // A non-matching fact scores 0.0, not 0.5. At 0.5 the floor was high enough that a fact
    // created today (recency 1.0) outscored an exact keyword match from three months ago
    // (0.3·1.0 + 0.4·0.5 = 0.50 vs 0.3·0.09 + 0.4·1.0 = 0.43) — recency beat relevance on every
    // query, which is exactly what the store exhibited. With a 0.0 floor, relevance leads when
    // anything matches, and recency still decides cleanly when nothing does.
    // Two relevance signals, taken at their best rather than by precedence.
    //
    // Cosine similarity is absolute — 0.55 means the same thing on every query, and anything
    // below the 0.3 threshold is absent entirely. FTS rank is only meaningful RELATIVE to its own
    // result set, so the top hit reads 1.0 whether it nailed the query or merely shared the word
    // "characters" with it. Capping the FTS contribution at FTS_CEILING keeps a purely incidental
    // keyword hit from outranking a genuinely close semantic match, while still letting a strong
    // multi-term keyword hit beat a marginal one.
    const FTS_CEILING = Number(process.env.IRA_FTS_CEILING ?? 0.55);
    const ftsScore = ftsFactIds.has(fact.id)
      ? FTS_CEILING * (0.4 + 0.6 * (ftsRank.get(fact.id) ?? 0))
      : 0;
    const relevance = Math.max(ftsScore, semanticSim.get(fact.id) ?? 0);

    // Soft project boost: a large additive bump (not a filter) so same-project facts rank
    // above similarly-relevant other-project ones, while other projects still surface if the
    // current one is sparse. Distinct from `tags`, which hard-filters.
    const boost =
      input.boostTags?.length && input.boostTags.some((t) => fact.tags.includes(t)) ? 0.5 : 0;

    const score =
      W.recency * recency +
      W.relevance * relevance +
      W.tier * tierWeight +
      W.confidence * fact.confidence +
      boost;

    return { ...fact, score };
  });

  scoredFacts.sort((a, b) => b.score - a.score);

  // FTS + semantic layers above add facts independent of the structured tag
  // filter. If the caller passed `tags`, enforce it as a final hard filter so
  // the contract is "tag-scoped or nothing."
  const filteredFacts = input.tags?.length
    ? scoredFacts.filter((f) => input.tags!.some((t) => f.tags.includes(t)))
    : scoredFacts;

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
    facts: filteredFacts.slice(0, limit),
    summaries: scoredSummaries.slice(0, limit),
    messages,
  };
}

// ─── Recall over messages (Phase 5: GET /conversation/recall) ───
//
// Deliberately separate from `recall()` above rather than folding messages
// into it: `recall()`'s candidate pool, scoring weights, and tag-filter
// contract are all fact-shaped (tier, confidence, isArchived) and already
// covered by callers/tests. Messages have none of that — they have a
// project/channel scope instead — so this mirrors the same two-layer
// FTS + semantic pattern deliberately, rather than overloading one function
// with two different candidate shapes.

const MESSAGE_FTS_CEILING = Number(process.env.IRA_FTS_CEILING ?? 0.55);

export async function recallMessages(input: RecallMessagesInput): Promise<RecallMessagesResult> {
  const limit = Math.min(input.limit ?? 20, 100);
  const candidateTake = Math.min(limit * 6, 200);

  const projectFilter = input.project ? Prisma.sql`AND s.metadata->>'project' = ${input.project}` : Prisma.empty;
  const channelFilter = input.channel ? Prisma.sql`AND s.channel = ${input.channel}` : Prisma.empty;

  const tsQuery = input.query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^\w]/g, ""))
    .filter(Boolean)
    .join(" | "); // OR semantics — see recall()'s note above on why AND silently no-ops on natural phrases.

  const ftsRank = new Map<string, number>();
  if (tsQuery) {
    const rows = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
      SELECT m.id, ts_rank(m.content_tsv, to_tsquery('english', ${tsQuery}), 1) as rank
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.content_tsv @@ to_tsquery('english', ${tsQuery})
        ${projectFilter} ${channelFilter}
      ORDER BY rank DESC
      LIMIT ${candidateTake}
    `;
    const maxRank = Math.max(...rows.map((r) => Number(r.rank) || 0), 0);
    if (maxRank > 0) rows.forEach((r) => ftsRank.set(r.id, (Number(r.rank) || 0) / maxRank));
  }

  const semSim = new Map<string, number>();
  if (process.env.IRA_SEMANTIC_RECALL !== "0") {
    try {
      const queryVector = await generateEmbedding(input.query);
      if (queryVector.length) {
        const vectorStr = `[${queryVector.join(",")}]`;
        const rows = await prisma.$queryRaw<Array<{ message_id: string; similarity: number }>>`
          SELECT message_id, MAX(similarity) AS similarity FROM (
            SELECT me.message_id, 1 - (me.vector <=> ${vectorStr}::vector) AS similarity
            FROM message_embeddings me
            JOIN messages m ON m.id = me.message_id
            JOIN sessions s ON s.id = m.session_id
            WHERE 1=1 ${projectFilter} ${channelFilter}
            ORDER BY me.vector <=> ${vectorStr}::vector
            LIMIT ${candidateTake}
          ) t
          WHERE similarity > 0.3
          GROUP BY message_id
          ORDER BY similarity DESC
          LIMIT ${candidateTake}
        `;
        rows.forEach((r) => semSim.set(r.message_id, Number(r.similarity) || 0));
      }
    } catch {
      // Semantic layer failure (e.g. embeddings disabled/API down) is non-fatal — FTS still applies.
    }
  }

  const allIds = Array.from(new Set([...ftsRank.keys(), ...semSim.keys()]));
  if (allIds.length === 0) return { messages: [] };

  const rows = await prisma.message.findMany({
    where: { id: { in: allIds } },
    include: { session: { select: { channel: true } } },
  });

  const now = Date.now();
  const scored = rows.map((m) => {
    const daysAgo = (now - m.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const recency = 1.0 / (1.0 + daysAgo * 0.1);
    const ftsScore = ftsRank.has(m.id) ? MESSAGE_FTS_CEILING * (0.4 + 0.6 * (ftsRank.get(m.id) ?? 0)) : 0;
    const relevance = Math.max(ftsScore, semSim.get(m.id) ?? 0);
    const score = 0.25 * recency + 0.75 * relevance;
    const { session, ...rest } = m as typeof m & { session: { channel: string } | null };
    return { ...rest, channel: session?.channel ?? null, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return { messages: scored.slice(0, limit) };
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
    ...(input?.tags?.length && { tags: { hasSome: input.tags } }),
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
