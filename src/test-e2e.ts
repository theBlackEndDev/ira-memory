#!/usr/bin/env bun
/**
 * End-to-end test: all phases verified.
 */
import {
  openSession,
  closeSession,
  storeMessage,
  store,
  recall,
  textSearch,
  semanticSearch,
  embedMessage,
  embedFact,
  summarize,
  promoteAndExpire,
  detectConflicts,
  compactMessages,
  exportAll,
  exportMarkdown,
  isSensitiveContent,
  prisma,
} from "./index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function test() {
  console.log("=== IRA Memory E2E Test Suite ===\n");

  // ─── Phase 1: Core CRUD ───────────────────────────────────────
  console.log("Phase 1: Core Operations");

  const session = await openSession({
    channel: "cli",
    title: "E2E Test Session",
    agentId: "test-agent",
  });
  assert(!!session.id, "openSession creates session");

  const msg1 = await storeMessage({
    sessionId: session.id,
    role: "user",
    content: "We should deploy the memory system to production using Docker containers with pgvector",
  });
  assert(!!msg1.id, "storeMessage stores user message");

  const msg2 = await storeMessage({
    sessionId: session.id,
    role: "assistant",
    content: "I'll set up the Docker Compose configuration with pgvector/pgvector:pg16 image and configure HNSW indexes",
  });
  assert(!!msg2.id, "storeMessage stores assistant message");

  // ─── Phase 2: Embeddings ──────────────────────────────────────
  console.log("\nPhase 2: Embeddings & Semantic Search");

  // Explicitly embed (normally async)
  const embedded1 = await embedMessage(msg1.id);
  assert(embedded1 === true, "embedMessage embeds user message");

  // msg2 may already be embedded by the async embedMessageAsync from storeMessage
  const embedded2 = await embedMessage(msg2.id);
  // Either true (we embedded it) or false (async already did) -- both correct
  const msg2HasEmbed = (await prisma.$queryRaw<Array<{count: bigint}>>`SELECT COUNT(*) as count FROM message_embeddings WHERE message_id = ${msg2.id}`)[0].count > 0n;
  assert(msg2HasEmbed, "assistant message has embedding (sync or async)");

  // Skip re-embed
  const reEmbed = await embedMessage(msg1.id);
  assert(reEmbed === false, "embedMessage skips already-embedded message");

  // Store and embed a fact
  const fact = await store({
    category: "DECISION",
    content: "Production deployment uses Docker with pgvector for the memory database",
    tier: "LONG_TERM",
    source: "explicit",
    tags: ["infrastructure", "e2e-test"],
  });
  assert(!!fact.id, "store creates fact");

  const factEmbedded = await embedFact(fact.id);
  assert(factEmbedded === true, "embedFact embeds fact");

  // Semantic search
  const semanticResults = await semanticSearch({
    query: "Docker deployment pgvector",
    tables: ["facts", "messages"],
    limit: 5,
    threshold: 0.3,
  });
  assert(semanticResults.facts.length > 0, "semanticSearch finds facts");
  assert(semanticResults.messages.length > 0, "semanticSearch finds messages");

  // Recall with semantic (Layer 4)
  const recallResults = await recall({
    query: "Docker deployment infrastructure",
    limit: 5,
  });
  assert(recallResults.facts.length > 0, "recall with query returns results");

  // ─── Phase 2: Summarization ───────────────────────────────────
  console.log("\nPhase 2: Session Summarization");

  // Close session triggers summary
  const { session: closedSession, summary } = await closeSession(session.id);
  assert(!!closedSession.endedAt, "closeSession sets endedAt");
  assert(summary !== null, "closeSession generates summary");
  if (summary) {
    assert(summary.scope === "SESSION", "summary scope is SESSION");
    assert(summary.content.length > 0, "summary has content");
    assert(summary.keyTopics.length > 0, "summary has key topics");
  }

  // ─── Phase 3: Tier Management ────────────────────────────────
  console.log("\nPhase 3: Tier Management");

  const maintResult = await promoteAndExpire();
  assert(typeof maintResult.promoted.shortToDaily === "number", "promoteAndExpire runs without error");
  assert(typeof maintResult.expired === "number", "promoteAndExpire reports expired count");

  const conflicts = await detectConflicts(5);
  assert(Array.isArray(conflicts), "detectConflicts returns array");

  // ─── Phase 4: Export & Sensitive Detection ────────────────────
  console.log("\nPhase 4: Export & Safety");

  assert(isSensitiveContent("my password is: hunter2") === true, "detects password in content");
  assert(isSensitiveContent("sk-proj-abc123def456ghi789jkl") === true, "detects OpenAI key");
  assert(isSensitiveContent("we deployed the app yesterday") === false, "normal content is not sensitive");

  // Store a sensitive fact
  const sensitiveFact = await store({
    category: "TOOL_CONFIG",
    content: "The API key is sk-proj-TESTKEY123456789012345678901234567890",
    tier: "LONG_TERM",
    tags: ["e2e-test"],
  });
  assert(sensitiveFact.isSensitive === true, "store auto-detects sensitive content");

  const mdExport = await exportMarkdown();
  assert(!mdExport.includes("sk-proj-TESTKEY"), "exportMarkdown excludes sensitive facts");
  assert(mdExport.includes("# IRA Memory Export"), "exportMarkdown has header");

  const jsonExport = await exportAll();
  assert(jsonExport.stats.facts > 0, "exportAll includes fact count");
  assert(!!jsonExport.exportedAt, "exportAll has timestamp");

  // ─── Phase 5: Compaction ──────────────────────────────────────
  console.log("\nPhase 5: Advanced");

  const compactResult = await compactMessages(90);
  assert(typeof compactResult.messagesArchived === "number", "compactMessages runs without error");

  // ─── Cleanup ──────────────────────────────────────────────────
  console.log("\nCleaning up test data...");

  // Delete test messages and session
  await prisma.message.deleteMany({ where: { sessionId: session.id } });
  if (summary) await prisma.summary.delete({ where: { id: summary.id } });
  await prisma.session.delete({ where: { id: session.id } });
  await prisma.memoryFact.delete({ where: { id: fact.id } }).catch(() => {});
  await prisma.memoryFact.delete({ where: { id: sensitiveFact.id } }).catch(() => {});
  // Clean up any facts extracted by summarization
  await prisma.memoryFact.deleteMany({ where: { tags: { has: "session-summary" }, sourceRef: session.id } });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

test()
  .catch((err) => {
    console.error("TEST ERROR:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
