#!/usr/bin/env bun
/**
 * Quick integration test: session + message + recall flow
 */
import {
  openSession,
  closeSession,
  storeMessage,
  store,
  recall,
  textSearch,
  prisma,
} from "./index.js";

async function test() {
  console.log("=== IRA Memory Integration Test ===\n");

  // 1. Open a session
  const session = await openSession({
    channel: "cli",
    title: "Integration Test Session",
  });
  console.log(`1. Opened session: ${session.id} (${session.channel})`);

  // 2. Store messages
  const msg1 = await storeMessage({
    sessionId: session.id,
    role: "user",
    content: "Let's work on the database migration for the memory system",
  });
  console.log(`2. Stored user message: ${msg1.id}`);

  const msg2 = await storeMessage({
    sessionId: session.id,
    role: "assistant",
    content: "I'll set up PostgreSQL with pgvector and create the Prisma schema for the memory tables",
  });
  console.log(`3. Stored assistant message: ${msg2.id}`);

  const msg3 = await storeMessage({
    sessionId: session.id,
    role: "tool",
    content: "Migration applied successfully",
    toolName: "bash",
    toolInput: { command: "prisma migrate dev" },
  });
  console.log(`4. Stored tool message: ${msg3.id}`);

  // 3. Store a fact from this session
  const fact = await store({
    category: "DECISION",
    content: "Using pgvector/pgvector:pg16 Docker image for the memory database",
    tier: "LONG_TERM",
    source: "explicit",
    sourceRef: msg2.id,
    tags: ["infrastructure", "database"],
  });
  console.log(`5. Stored decision fact: ${fact.id}`);

  // 4. Close session
  const { session: closedSession } = await closeSession(session.id);
  console.log(`6. Closed session: ${closedSession.endedAt?.toISOString()}`);

  // 5. Test recall - structured
  const recallResult = await recall({
    categories: ["DECISION"],
    tier: "LONG_TERM",
    limit: 5,
  });
  console.log(`7. Recall (DECISION/LONG_TERM): ${recallResult.facts.length} facts`);

  // 6. Test recall - with query (FTS)
  const recallWithQuery = await recall({
    query: "pgvector migration",
    limit: 5,
  });
  console.log(`8. Recall (query "pgvector migration"): ${recallWithQuery.facts.length} facts`);

  // 7. Test recall - with messages
  const recallWithMessages = await recall({
    sessionId: session.id,
    includeMessages: true,
    limit: 10,
  });
  console.log(`9. Recall (session messages): ${recallWithMessages.messages?.length ?? 0} messages`);

  // 8. Test text search
  const searchResult = await textSearch({ query: "database migration" });
  console.log(`10. Text search "database migration": ${searchResult.facts.length} facts, ${searchResult.messages.length} messages`);

  // Clean up test data
  await prisma.message.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.delete({ where: { id: session.id } });
  await prisma.memoryFact.delete({ where: { id: fact.id } });
  console.log(`\n11. Cleaned up test data`);

  console.log("\n=== All tests passed ===");
}

test()
  .catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
