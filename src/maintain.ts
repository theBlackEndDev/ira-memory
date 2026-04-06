import { prisma } from "./client.js";
import type { MemoryFact } from "./types.js";

export interface MaintenanceResult {
  promoted: { shortToDaily: number; dailyToLong: number };
  expired: number;
  conflicts: ConflictPair[];
}

export interface ConflictPair {
  factA: MemoryFact;
  factB: MemoryFact;
  reason: string;
}

/**
 * Run tier promotion and expiration.
 * - SHORT_TERM facts older than 48h: promote to DAILY or archive
 * - DAILY facts older than 7d: promote to LONG_TERM
 */
export async function promoteAndExpire(): Promise<{
  promoted: { shortToDaily: number; dailyToLong: number };
  expired: number;
}> {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Promote SHORT_TERM -> DAILY (facts older than 48h that aren't expired)
  // Only promote facts with higher confidence or that were explicitly stored
  const shortTermOld = await prisma.memoryFact.findMany({
    where: {
      tier: "SHORT_TERM",
      isArchived: false,
      createdAt: { lt: twoDaysAgo },
      OR: [
        { confidence: { gte: 0.7 } },
        { source: "explicit" },
        { source: "imported" },
      ],
    },
  });

  const shortToDaily = await prisma.memoryFact.updateMany({
    where: { id: { in: shortTermOld.map((f) => f.id) } },
    data: { tier: "DAILY" },
  });

  // Archive SHORT_TERM facts older than 48h that weren't promoted
  // (low confidence, inferred, or expired)
  const expiredResult = await prisma.memoryFact.updateMany({
    where: {
      tier: "SHORT_TERM",
      isArchived: false,
      createdAt: { lt: twoDaysAgo },
      // These are the ones NOT promoted above
      AND: [
        { confidence: { lt: 0.7 } },
        { source: { not: "explicit" } },
        { source: { not: "imported" } },
      ],
    },
    data: { isArchived: true },
  });

  // Also archive anything with explicit expiresAt in the past
  const expiredByDate = await prisma.memoryFact.updateMany({
    where: {
      isArchived: false,
      expiresAt: { lt: now },
    },
    data: { isArchived: true },
  });

  // Promote DAILY -> LONG_TERM (facts older than 7d)
  const dailyOld = await prisma.memoryFact.findMany({
    where: {
      tier: "DAILY",
      isArchived: false,
      createdAt: { lt: sevenDaysAgo },
    },
  });

  const dailyToLong = await prisma.memoryFact.updateMany({
    where: { id: { in: dailyOld.map((f) => f.id) } },
    data: { tier: "LONG_TERM" },
  });

  return {
    promoted: {
      shortToDaily: shortToDaily.count,
      dailyToLong: dailyToLong.count,
    },
    expired: expiredResult.count + expiredByDate.count,
  };
}

/**
 * Detect potentially conflicting facts.
 * Two facts conflict if they have the same category, overlapping keywords,
 * and one is more recent (possible supersession that wasn't linked).
 */
export async function detectConflicts(limit: number = 20): Promise<ConflictPair[]> {
  const conflicts: ConflictPair[] = [];

  // Focus on categories where conflicts are meaningful
  const conflictCategories = ["DECISION", "PREFERENCE", "PROJECT_STATE", "FACT"] as const;

  for (const category of conflictCategories) {
    const facts = await prisma.memoryFact.findMany({
      where: {
        category,
        isArchived: false,
        supersededBy: null,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Compare pairs looking for high textual overlap
    for (let i = 0; i < facts.length && conflicts.length < limit; i++) {
      for (let j = i + 1; j < facts.length && conflicts.length < limit; j++) {
        const similarity = jaccardSimilarity(
          tokenize(facts[i].content),
          tokenize(facts[j].content)
        );

        if (similarity > 0.4) {
          conflicts.push({
            factA: facts[i],
            factB: facts[j],
            reason: `${(similarity * 100).toFixed(0)}% word overlap in ${category} facts`,
          });
        }
      }
    }
  }

  return conflicts.slice(0, limit);
}

/**
 * Compact old messages: archive messages older than daysOld days,
 * but keep summaries and facts intact.
 */
export async function compactMessages(daysOld: number = 90): Promise<{
  messagesArchived: number;
  embeddingsRemoved: number;
}> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

  // Remove embeddings for old messages (regenerable)
  const embeddingsResult = await prisma.$executeRaw`
    DELETE FROM message_embeddings
    WHERE message_id IN (
      SELECT id FROM messages WHERE created_at < ${cutoff}
    )
  `;

  // Count messages that will be affected
  const messageCount = await prisma.message.count({
    where: { createdAt: { lt: cutoff } },
  });

  // Truncate content of old messages to save space but keep metadata
  await prisma.$executeRaw`
    UPDATE messages
    SET content = LEFT(content, 200) || '... [compacted]'
    WHERE created_at < ${cutoff}
      AND LENGTH(content) > 200
      AND content NOT LIKE '%[compacted]'
  `;

  return {
    messagesArchived: messageCount,
    embeddingsRemoved: Number(embeddingsResult),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}
