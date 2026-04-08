import { prisma } from "./client.js";
import { embedMessageAsync, embedFactAsync } from "./embed.js";
import { isSensitiveContent } from "./export.js";
import { summarize } from "./summarize.js";
import type {
  OpenSessionInput,
  StoreMessageInput,
  StoreFactInput,
  Session,
  Message,
  MemoryFact,
  Summary,
} from "./types.js";

export async function openSession(input: OpenSessionInput): Promise<Session> {
  return prisma.session.create({
    data: {
      channel: input.channel,
      agentId: input.agentId,
      hostId: input.hostId,
      title: input.title,
      metadata: (input.metadata ?? undefined) as any,
    },
  });
}

export interface CloseSessionOptions {
  /** Run LLM session summary during close. Default true. */
  summarize?: boolean;
  /** Run LLM learning extraction during close. Default true. */
  learn?: boolean;
}

export async function closeSession(
  sessionId: string,
  opts: CloseSessionOptions = {}
): Promise<{ session: Session; summary: Summary | null }> {
  const runSummarize = opts.summarize ?? true;
  const runLearn = opts.learn ?? true;

  const session = await prisma.session.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
  });

  // Generate session summary
  let sessionSummary: Summary | null = null;
  if (runSummarize) {
    try {
      const msgCount = await prisma.message.count({ where: { sessionId } });
      if (msgCount > 0) {
        sessionSummary = await summarize({ scope: "SESSION", sessionId });
      }
    } catch (err) {
      console.error(`[closeSession] Failed to summarize session ${sessionId}:`, err);
    }
  }

  // Extract learnings from the session (opt-out via IRA_AUTO_LEARN=false)
  if (runLearn && process.env.IRA_AUTO_LEARN !== "false") {
    try {
      const msgCount = await prisma.message.count({ where: { sessionId } });
      if (msgCount >= 3) {
        const { learn } = await import("./learn.js");
        await learn({ sessionId, dedup: true, minConfidence: 0.7 });
      }
    } catch (err) {
      console.error(`[closeSession] Failed to extract learnings for session ${sessionId}:`, err);
    }
  }

  return { session, summary: sessionSummary };
}

export async function storeMessage(input: StoreMessageInput): Promise<Message> {
  const message = await prisma.message.create({
    data: {
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      toolName: input.toolName,
      toolInput: (input.toolInput ?? undefined) as any,
      toolOutput: (input.toolOutput ?? undefined) as any,
      tokenCount: input.tokenCount,
      model: input.model,
      costUsd: input.costUsd,
      metadata: (input.metadata ?? undefined) as any,
    },
  });

  // Async embed (non-blocking)
  embedMessageAsync(message.id);

  return message;
}

export async function store(input: StoreFactInput): Promise<MemoryFact> {
  // Auto-detect sensitive content if not explicitly set
  const sensitive = input.isSensitive ?? isSensitiveContent(input.content);

  const fact = await prisma.memoryFact.create({
    data: {
      category: input.category,
      tier: input.tier ?? "SHORT_TERM",
      content: input.content,
      source: input.source,
      sourceRef: input.sourceRef,
      confidence: input.confidence ?? 1.0,
      tags: input.tags ?? [],
      isSensitive: sensitive,
      expiresAt: input.expiresAt,
      metadata: (input.metadata ?? undefined) as any,
      learningType: input.learningType,
      provenance: input.provenance,
    },
  });

  // Async embed (non-blocking)
  embedFactAsync(fact.id);

  return fact;
}

export async function forget(factId: string): Promise<void> {
  await prisma.memoryFact.update({
    where: { id: factId },
    data: { isArchived: true },
  });
}

export async function hardDelete(factId: string): Promise<void> {
  await prisma.memoryFact.delete({
    where: { id: factId },
  });
}

export async function updateFact(
  factId: string,
  updates: Partial<{
    content: string;
    category: MemoryFact["category"];
    tier: MemoryFact["tier"];
    tags: string[];
  }>
): Promise<MemoryFact> {
  // Create new version, supersede old
  const old = await prisma.memoryFact.findUniqueOrThrow({
    where: { id: factId },
  });

  const newFact = await prisma.memoryFact.create({
    data: {
      category: updates.category ?? old.category,
      tier: updates.tier ?? old.tier,
      content: updates.content ?? old.content,
      source: old.source,
      sourceRef: old.sourceRef,
      confidence: old.confidence,
      tags: updates.tags ?? old.tags,
      isSensitive: old.isSensitive,
      expiresAt: old.expiresAt,
      metadata: (old.metadata ?? undefined) as any,
    },
  });

  await prisma.memoryFact.update({
    where: { id: factId },
    data: { supersededBy: newFact.id, isArchived: true },
  });

  return newFact;
}

export async function promote(
  factId: string,
  toTier: MemoryFact["tier"]
): Promise<MemoryFact> {
  return prisma.memoryFact.update({
    where: { id: factId },
    data: { tier: toTier },
  });
}
