#!/usr/bin/env bun
// @ts-nocheck — CLI parseArgs types are intentionally loose
import { parseArgs } from "node:util";
import {
  openSession,
  closeSession,
  storeMessage,
  store,
  forget,
  hardDelete,
  recall,
  textSearch,
  semanticSearch,
  listFacts,
  importFromFiles,
  summarize,
  learn,
  discover,
  synthesize,
  promoteAndExpire,
  detectConflicts,
  compactMessages,
  exportAll,
  exportMarkdown,
  backup,
  restore,
  detectSensitiveFacts,
  backfillFactEmbeddings,
  backfillMessageEmbeddings,
  prisma,
} from "./index.js";
import type { MemoryCategory, MemoryTier, SummaryScope, LearningType } from "@prisma/client";
import type { DiscoverAspect } from "./types.js";

const CATEGORIES: MemoryCategory[] = [
  "PREFERENCE", "DECISION", "PLAN", "TODO", "FACT", "LESSON",
  "CHECKPOINT", "CONTEXT", "TOOL_CONFIG", "PROJECT_STATE",
];

const TIERS: MemoryTier[] = ["SHORT_TERM", "DAILY", "LONG_TERM"];

const LEARNING_TYPES: LearningType[] = [
  "MISTAKE", "BEST_PRACTICE", "INSTITUTIONAL", "WORKFLOW_PREF", "CODEBASE_RULE",
];

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subArgs = args.slice(1);

  switch (command) {
    case "list":       return cmdList(subArgs);
    case "search":     return cmdSearch(subArgs);
    case "semantic":   return cmdSemantic(subArgs);
    case "store":      return cmdStore(subArgs);
    case "forget":     return cmdForget(subArgs);
    case "delete":     return cmdDelete(subArgs);
    case "import":     return cmdImport(subArgs);
    case "stats":      return cmdStats();
    case "sessions":   return cmdSessions(subArgs);
    case "recall":     return cmdRecall(subArgs);
    case "summarize":  return cmdSummarize(subArgs);
    case "maintain":   return cmdMaintain();
    case "compact":    return cmdCompact(subArgs);
    case "conflicts":  return cmdConflicts(subArgs);
    case "threads":    return cmdThreads(subArgs);
    case "export":     return cmdExport(subArgs);
    case "backup":     return cmdBackup();
    case "restore":    return cmdRestore(subArgs);
    case "backfill":   return cmdBackfill(subArgs);
    case "detect-sensitive": return cmdDetectSensitive();
    case "learn":      return cmdLearn(subArgs);
    case "discover":   return cmdDiscover(subArgs);
    case "synthesize": return cmdSynthesize(subArgs);
    case "install-hooks": return cmdInstallHooks();
    case "capture":    return cmdCapture(subArgs);
    default:           printUsage();
  }
}

function printUsage() {
  console.log(`
IRA Memory CLI

Usage: bun run src/cli.ts <command> [options]

Commands:
  list      [--category CAT] [--tier TIER] [--limit N]   List memory facts
  search    <query>                                       Full-text search
  semantic  <query> [--tables facts,summaries,messages]   Semantic vector search
  recall    [--query Q] [--categories C1,C2] [--since D]  Multi-layer recall
  store     --category CAT --content "..." [--tier TIER]  Store a memory fact
  forget    <id>                                          Archive a fact (soft)
  delete    <id>                                          Permanently delete a fact
  import    [--memory-md PATH] [--daily-dir PATH]         Import file-based memory
  sessions  [--limit N]                                   List sessions
  stats                                                   Show memory statistics
  summarize --scope SESSION|DAILY|WEEKLY|PROJECT [opts]   Generate a summary
  maintain                                                Run tier promotion/expiration
  compact   [--days N]                                    Compact old messages (default 90d)
  conflicts [--limit N]                                   Detect conflicting facts
  threads   [--limit N]                                   Show session threading chains
  export    [--format json|md]                            Export memory
  backup                                                  Create pg_dump backup
  restore   <filepath>                                    Restore from pg_dump
  backfill  [--type facts|messages] [--batch N]           Backfill embeddings
  detect-sensitive                                        Scan and mark sensitive facts

  learn     --session ID [--types T1,T2] [--dedup]         Extract learnings from a session
  discover  <directory> [--aspects A1,A2] [--project NAME]  Mine knowledge from source code
  synthesize <question> [--save] [--categories C1,C2]      Synthesize knowledge from memory

  install-hooks                                            Install Claude Code session capture hooks
  capture   --transcript PATH [--session-id ID]            Manually capture a CC transcript

Categories: ${CATEGORIES.join(", ")}
Tiers: ${TIERS.join(", ")}
Learning Types: ${LEARNING_TYPES.join(", ")}
`);
}

// ─── Phase 1 commands (unchanged) ───────────────────────────────

async function cmdList(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      category: { type: "string" },
      tier: { type: "string" },
      limit: { type: "string", default: "20" },
      archived: { type: "boolean", default: false },
    },
    strict: false,
  });

  const { facts, total } = await listFacts({
    category: values.category as MemoryCategory | undefined,
    tier: values.tier as MemoryTier | undefined,
    limit: parseInt(values.limit ?? "20"),
    includeArchived: values.archived,
  });

  console.log(`\nMemory Facts (${facts.length} of ${total}):\n`);
  for (const fact of facts) {
    const sensitive = fact.isSensitive ? " [SENSITIVE]" : "";
    const archived = fact.isArchived ? " [ARCHIVED]" : "";
    console.log(`  [${fact.id}] ${fact.category}/${fact.tier}${sensitive}${archived}`);
    console.log(`    ${fact.content.slice(0, 120)}${fact.content.length > 120 ? "..." : ""}`);
    console.log(`    tags: ${fact.tags.join(", ") || "none"} | ${fact.createdAt.toISOString()}`);
    console.log();
  }
}

async function cmdSearch(args: string[]) {
  const query = args.join(" ");
  if (!query) {
    console.error("Usage: search <query>");
    process.exit(1);
  }

  const results = await textSearch({ query, limit: 20 });

  if (results.facts.length > 0) {
    console.log(`\nFacts (${results.facts.length}):\n`);
    for (const fact of results.facts) {
      console.log(`  [${fact.id}] ${fact.category}/${fact.tier} (rank: ${fact.rank.toFixed(4)})`);
      console.log(`    ${fact.content.slice(0, 120)}${fact.content.length > 120 ? "..." : ""}`);
      console.log();
    }
  }

  if (results.messages.length > 0) {
    console.log(`\nMessages (${results.messages.length}):\n`);
    for (const msg of results.messages) {
      console.log(`  [${msg.id}] ${msg.role} (rank: ${msg.rank.toFixed(4)})`);
      console.log(`    ${msg.content.slice(0, 120)}${msg.content.length > 120 ? "..." : ""}`);
      console.log();
    }
  }

  if (results.facts.length === 0 && results.messages.length === 0) {
    console.log("\nNo results found.");
  }
}

async function cmdRecall(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: "string" },
      categories: { type: "string" },
      tier: { type: "string" },
      since: { type: "string" },
      limit: { type: "string", default: "20" },
      messages: { type: "boolean", default: false },
    },
    strict: false,
  });

  const categories = values.categories
    ?.split(",")
    .map((c) => c.trim().toUpperCase()) as MemoryCategory[] | undefined;

  const results = await recall({
    query: values.query,
    categories,
    tier: values.tier as MemoryTier | undefined,
    timeRange: values.since ? { after: new Date(values.since) } : undefined,
    limit: parseInt(values.limit ?? "20"),
    includeMessages: values.messages,
  });

  console.log(`\nRecall Results:`);

  if (results.facts.length > 0) {
    console.log(`\n  Facts (${results.facts.length}):`);
    for (const fact of results.facts) {
      console.log(`    [${fact.id}] ${fact.category}/${fact.tier} (score: ${fact.score.toFixed(3)})`);
      console.log(`      ${fact.content.slice(0, 100)}${fact.content.length > 100 ? "..." : ""}`);
    }
  }

  if (results.summaries.length > 0) {
    console.log(`\n  Summaries (${results.summaries.length}):`);
    for (const s of results.summaries) {
      console.log(`    [${s.id}] ${s.scope} (score: ${s.score.toFixed(3)})`);
      console.log(`      ${s.content.slice(0, 100)}${s.content.length > 100 ? "..." : ""}`);
    }
  }

  if (results.messages && results.messages.length > 0) {
    console.log(`\n  Messages (${results.messages.length}):`);
    for (const m of results.messages) {
      console.log(`    [${m.id}] ${m.role} (score: ${m.score.toFixed(3)})`);
      console.log(`      ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`);
    }
  }

  const total = results.facts.length + results.summaries.length + (results.messages?.length ?? 0);
  if (total === 0) {
    console.log("\n  No results found.");
  }
}

async function cmdStore(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      category: { type: "string" },
      content: { type: "string" },
      tier: { type: "string", default: "LONG_TERM" },
      tags: { type: "string" },
      sensitive: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (!values.category || !values.content) {
    console.error("Usage: store --category CAT --content \"...\" [--tier TIER] [--tags t1,t2]");
    process.exit(1);
  }

  const fact = await store({
    category: values.category.toUpperCase() as MemoryCategory,
    content: values.content,
    tier: (values.tier?.toUpperCase() ?? "LONG_TERM") as MemoryTier,
    source: "explicit",
    tags: values.tags?.split(",").map((t) => t.trim()) ?? [],
    isSensitive: values.sensitive,
  });

  console.log(`\nStored fact: ${fact.id}`);
  console.log(`  Category: ${fact.category}`);
  console.log(`  Tier: ${fact.tier}`);
  console.log(`  Sensitive: ${fact.isSensitive}`);
  console.log(`  Content: ${fact.content}`);
}

async function cmdForget(args: string[]) {
  const id = args[0];
  if (!id) { console.error("Usage: forget <fact-id>"); process.exit(1); }
  await forget(id);
  console.log(`Archived fact: ${id}`);
}

async function cmdDelete(args: string[]) {
  const id = args[0];
  if (!id) { console.error("Usage: delete <fact-id>"); process.exit(1); }
  await hardDelete(id);
  console.log(`Permanently deleted fact: ${id}`);
}

async function cmdImport(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "memory-md": { type: "string" },
      "daily-dir": { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: false,
  });

  const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
  const memoryMdPath = values["memory-md"] ?? `${homeDir}/.claude/MEMORY.md`;
  const dailyDir = values["daily-dir"] ?? `${homeDir}/.claude/memory`;

  console.log(`Importing from:`);
  console.log(`  MEMORY.md: ${memoryMdPath}`);
  console.log(`  Daily dir: ${dailyDir}\n`);

  const result = await importFromFiles({ memoryMdPath, dailyDir, force: values.force });

  console.log(`Import complete:`);
  console.log(`  Files processed: ${result.filesProcessed}`);
  console.log(`  Facts created: ${result.factsCreated}`);
  console.log(`  Facts skipped: ${result.factsSkipped}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of result.errors) console.log(`    - ${err}`);
  }
}

async function cmdSessions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { limit: { type: "string", default: "10" } },
    strict: false,
  });

  const sessions = await prisma.session.findMany({
    orderBy: { startedAt: "desc" },
    take: parseInt(values.limit ?? "10"),
    include: { _count: { select: { messages: true } } },
  });

  console.log(`\nSessions (${sessions.length}):\n`);
  for (const s of sessions) {
    const status = s.endedAt ? "closed" : "open";
    console.log(`  [${s.id}] ${s.channel} (${status}) - ${s._count.messages} messages`);
    console.log(`    ${s.title ?? "untitled"} | started: ${s.startedAt.toISOString()}`);
    if (s.parentSessionId) console.log(`    parent: ${s.parentSessionId}`);
    console.log();
  }
}

async function cmdStats() {
  const [sessionCount, messageCount, factCount, factsByCategory, factsByTier, summaryCount, embeddedFacts, embeddedMessages] = await Promise.all([
    prisma.session.count(),
    prisma.message.count(),
    prisma.memoryFact.count({ where: { isArchived: false } }),
    prisma.memoryFact.groupBy({ by: ["category"], where: { isArchived: false }, _count: true }),
    prisma.memoryFact.groupBy({ by: ["tier"], where: { isArchived: false }, _count: true }),
    prisma.summary.count(),
    prisma.$queryRaw<[{count: bigint}]>`SELECT COUNT(*) as count FROM fact_embeddings`,
    prisma.$queryRaw<[{count: bigint}]>`SELECT COUNT(*) as count FROM message_embeddings`,
  ]);

  console.log(`\nIRA Memory Stats:\n`);
  console.log(`  Sessions:        ${sessionCount}`);
  console.log(`  Messages:        ${messageCount}`);
  console.log(`  Active Facts:    ${factCount}`);
  console.log(`  Summaries:       ${summaryCount}`);
  console.log(`  Fact Embeddings: ${embeddedFacts[0].count}`);
  console.log(`  Msg Embeddings:  ${embeddedMessages[0].count}`);
  console.log();
  console.log(`  By Category:`);
  for (const g of factsByCategory) console.log(`    ${g.category}: ${g._count}`);
  console.log();
  console.log(`  By Tier:`);
  for (const g of factsByTier) console.log(`    ${g.tier}: ${g._count}`);
}

// ─── Phase 2: Semantic search ───────────────────────────────────

async function cmdSemantic(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      tables: { type: "string", default: "facts,summaries" },
      limit: { type: "string", default: "10" },
      threshold: { type: "string", default: "0.3" },
    },
    strict: false,
    allowPositionals: true,
  });

  const query = positionals.join(" ");
  if (!query) {
    console.error("Usage: semantic <query> [--tables facts,summaries,messages]");
    process.exit(1);
  }

  const tables = (values.tables ?? "facts,summaries").split(",").map((t) => t.trim()) as Array<"facts" | "summaries" | "messages">;

  console.log(`\nSemantic search: "${query}"\n`);

  const results = await semanticSearch({
    query,
    tables,
    limit: parseInt(values.limit ?? "10"),
    threshold: parseFloat(values.threshold ?? "0.3"),
  });

  if (results.facts.length > 0) {
    console.log(`  Facts (${results.facts.length}):`);
    for (const f of results.facts) {
      console.log(`    [${f.id}] ${f.category}/${f.tier} (sim: ${f.similarity.toFixed(4)})`);
      console.log(`      ${f.content.slice(0, 120)}${f.content.length > 120 ? "..." : ""}`);
    }
    console.log();
  }

  if (results.summaries.length > 0) {
    console.log(`  Summaries (${results.summaries.length}):`);
    for (const s of results.summaries) {
      console.log(`    [${s.id}] ${s.scope} (sim: ${s.similarity.toFixed(4)})`);
      console.log(`      ${s.content.slice(0, 120)}${s.content.length > 120 ? "..." : ""}`);
    }
    console.log();
  }

  if (results.messages.length > 0) {
    console.log(`  Messages (${results.messages.length}):`);
    for (const m of results.messages) {
      console.log(`    [${m.id}] ${m.role} (sim: ${m.similarity.toFixed(4)})`);
      console.log(`      ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}`);
    }
    console.log();
  }

  const total = results.facts.length + results.summaries.length + results.messages.length;
  if (total === 0) console.log("  No results found.");
}

// ─── Phase 2/3: Summarize ───────────────────────────────────────

async function cmdSummarize(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      scope: { type: "string" },
      session: { type: "string" },
      date: { type: "string" },
      project: { type: "string" },
    },
    strict: false,
  });

  if (!values.scope) {
    console.error("Usage: summarize --scope SESSION|DAILY|WEEKLY|PROJECT [--session ID] [--date YYYY-MM-DD] [--project NAME]");
    process.exit(1);
  }

  const scope = values.scope.toUpperCase() as SummaryScope;

  console.log(`Generating ${scope} summary...`);

  const summary = await summarize({
    scope,
    sessionId: values.session,
    periodStart: values.date ? new Date(values.date) : undefined,
    projectName: values.project,
  });

  console.log(`\nSummary [${summary.id}] (${summary.scope}):`);
  console.log(`  Period: ${summary.periodStart.toISOString()} - ${summary.periodEnd.toISOString()}`);
  console.log(`  Topics: ${summary.keyTopics.join(", ") || "none"}`);
  console.log(`  Facts extracted: ${summary.factIds.length}`);
  console.log(`\n${summary.content}`);
}

// ─── Phase 3: Maintenance ───────────────────────────────────────

async function cmdMaintain() {
  console.log("Running tier promotion and expiration...\n");

  const result = await promoteAndExpire();

  console.log(`Tier Promotion:`);
  console.log(`  SHORT_TERM -> DAILY: ${result.promoted.shortToDaily}`);
  console.log(`  DAILY -> LONG_TERM:  ${result.promoted.dailyToLong}`);
  console.log(`  Expired/archived:    ${result.expired}`);
}

async function cmdCompact(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { days: { type: "string", default: "90" } },
    strict: false,
  });

  const days = parseInt(values.days ?? "90");
  console.log(`Compacting messages older than ${days} days...\n`);

  const result = await compactMessages(days);

  console.log(`Compaction complete:`);
  console.log(`  Messages compacted:   ${result.messagesArchived}`);
  console.log(`  Embeddings removed:   ${result.embeddingsRemoved}`);
}

async function cmdConflicts(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { limit: { type: "string", default: "20" } },
    strict: false,
  });

  console.log("Detecting conflicting facts...\n");

  const conflicts = await detectConflicts(parseInt(values.limit ?? "20"));

  if (conflicts.length === 0) {
    console.log("No conflicts detected.");
    return;
  }

  console.log(`Found ${conflicts.length} potential conflicts:\n`);
  for (const c of conflicts) {
    console.log(`  Conflict: ${c.reason}`);
    console.log(`    A [${c.factA.id}]: ${c.factA.content.slice(0, 80)}...`);
    console.log(`    B [${c.factB.id}]: ${c.factB.content.slice(0, 80)}...`);
    console.log();
  }
}

// ─── Phase 4: Export / Backup ───────────────────────────────────

async function cmdExport(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { format: { type: "string", default: "md" } },
    strict: false,
  });

  if (values.format === "json") {
    const data = await exportAll();
    console.log(JSON.stringify(data, null, 2));
  } else {
    const md = await exportMarkdown();
    console.log(md);
  }
}

async function cmdBackup() {
  console.log("Creating database backup...");
  const filepath = await backup();
  console.log(`Backup created: ${filepath}`);
}

async function cmdRestore(args: string[]) {
  const filepath = args[0];
  if (!filepath) {
    console.error("Usage: restore <filepath>");
    process.exit(1);
  }
  console.log(`Restoring from: ${filepath}`);
  await restore(filepath);
  console.log("Restore complete.");
}

// ─── Phase 2: Backfill embeddings ───────────────────────────────

async function cmdBackfill(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      type: { type: "string", default: "facts" },
      batch: { type: "string", default: "50" },
    },
    strict: false,
  });

  const batchSize = parseInt(values.batch ?? "50");
  const type = values.type ?? "facts";

  if (type === "facts" || type === "all") {
    console.log("Backfilling fact embeddings...");
    const count = await backfillFactEmbeddings(batchSize, (done, total) => {
      process.stdout.write(`\r  Progress: ${done}/${total}`);
    });
    console.log(`\n  Embedded ${count} facts.`);
  }

  if (type === "messages" || type === "all") {
    console.log("Backfilling message embeddings...");
    const count = await backfillMessageEmbeddings(batchSize, (done, total) => {
      process.stdout.write(`\r  Progress: ${done}/${total}`);
    });
    console.log(`\n  Embedded ${count} messages.`);
  }
}

// ─── Phase 4: Detect sensitive ──────────────────────────────────

async function cmdDetectSensitive() {
  console.log("Scanning facts for sensitive content...");
  const count = await detectSensitiveFacts();
  console.log(`Marked ${count} facts as sensitive.`);
}

// ─── Phase 5: Session threads ───────────────────────────────────

async function cmdThreads(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { limit: { type: "string", default: "10" } },
    strict: false,
  });

  // Find sessions with parentSessionId set
  const threaded = await prisma.session.findMany({
    where: { parentSessionId: { not: null } },
    orderBy: { startedAt: "desc" },
    take: parseInt(values.limit ?? "10"),
    include: { _count: { select: { messages: true } } },
  });

  if (threaded.length === 0) {
    console.log("\nNo threaded sessions found.");
    console.log("Sessions are threaded when opened with a parentSessionId.");
    return;
  }

  console.log(`\nThreaded Sessions (${threaded.length}):\n`);

  // Group by parent
  const byParent = new Map<string, typeof threaded>();
  for (const s of threaded) {
    const parent = s.parentSessionId!;
    const existing = byParent.get(parent) ?? [];
    existing.push(s);
    byParent.set(parent, existing);
  }

  for (const [parentId, children] of byParent) {
    const parent = await prisma.session.findUnique({ where: { id: parentId } });
    console.log(`  Thread root: [${parentId}] ${parent?.title ?? "untitled"} (${parent?.channel})`);
    for (const child of children) {
      console.log(`    └─ [${child.id}] ${child.title ?? "untitled"} - ${child._count.messages} msgs`);
    }
    console.log();
  }
}

// ─── Phase 6: Learning layer ───────────────────────────────────

async function cmdLearn(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      types: { type: "string" },
      context: { type: "string" },
      "min-confidence": { type: "string", default: "0.6" },
      dedup: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (!values.session) {
    console.error("Usage: learn --session <sessionId> [--types MISTAKE,BEST_PRACTICE,...] [--dedup]");
    process.exit(1);
  }

  const types = values.types
    ?.split(",")
    .map((t) => t.trim().toUpperCase()) as LearningType[] | undefined;

  console.log(`Extracting learnings from session ${values.session}...\n`);

  const result = await learn({
    sessionId: values.session,
    types,
    context: values.context,
    minConfidence: parseFloat(values["min-confidence"] ?? "0.6"),
    dedup: values.dedup,
  });

  if (result.learnings.length === 0) {
    console.log("No learnings extracted.");
    if (result.skipped > 0) console.log(`  (${result.skipped} skipped as duplicates)`);
    return;
  }

  console.log(`Extracted ${result.totalExtracted} learnings (${result.skipped} skipped as duplicates):\n`);
  for (const l of result.learnings) {
    console.log(`  [${l.learningType}] (confidence: ${l.confidence.toFixed(2)})`);
    console.log(`    ${l.fact.content}`);
    if (l.reasoning) console.log(`    Reasoning: ${l.reasoning}`);
    console.log(`    Fact ID: ${l.fact.id}`);
    console.log();
  }
}

async function cmdDiscover(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      aspects: { type: "string" },
      project: { type: "string" },
      "max-files": { type: "string", default: "100" },
      include: { type: "string" },
      exclude: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const directory = positionals[0];
  if (!directory) {
    console.error("Usage: discover <directory> [--aspects architecture,naming,...] [--project NAME]");
    process.exit(1);
  }

  const aspects = values.aspects
    ?.split(",")
    .map((a) => a.trim().toLowerCase()) as DiscoverAspect[] | undefined;

  console.log(`Discovering knowledge from ${directory}...`);
  if (values.project) console.log(`  Project: ${values.project}`);
  console.log();

  const result = await discover({
    directory,
    aspects,
    projectName: values.project,
    maxFiles: parseInt(values["max-files"] ?? "100"),
    include: values.include?.split(",").map((s) => s.trim()),
    exclude: values.exclude?.split(",").map((s) => s.trim()),
    force: values.force,
  });

  if (result.filesScanned === 0 && result.totalDiscovered === 0) {
    console.log("No new discoveries (directory unchanged or empty). Use --force to re-scan.");
    return;
  }

  console.log(`Scanned ${result.filesScanned} files, discovered ${result.totalDiscovered} insights:\n`);
  for (const d of result.discoveries) {
    console.log(`  [${d.aspect}] (confidence: ${d.confidence.toFixed(2)})`);
    console.log(`    ${d.fact.content}`);
    if (d.evidence.length > 0) console.log(`    Evidence: ${d.evidence.join(", ")}`);
    console.log(`    Fact ID: ${d.fact.id}`);
    console.log();
  }
}

async function cmdSynthesize(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      categories: { type: "string" },
      "learning-types": { type: "string" },
      messages: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      tags: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const question = positionals.join(" ");
  if (!question) {
    console.error('Usage: synthesize "<question>" [--save] [--categories C1,C2] [--learning-types T1,T2]');
    process.exit(1);
  }

  const categories = values.categories
    ?.split(",")
    .map((c) => c.trim().toUpperCase()) as MemoryCategory[] | undefined;

  const learningTypes = values["learning-types"]
    ?.split(",")
    .map((t) => t.trim().toUpperCase()) as LearningType[] | undefined;

  console.log(`Synthesizing knowledge for: "${question}"\n`);

  const result = await synthesize({
    question,
    categories,
    learningTypes,
    includeMessages: values.messages,
    save: values.save,
    tags: values.tags?.split(",").map((t) => t.trim()),
  });

  console.log(`Synthesis (confidence: ${result.confidence.toFixed(2)}):\n`);
  console.log(result.synthesis);

  console.log(`\nSources: ${result.sourceFacts.length} facts, ${result.sourceSummaries.length} summaries`);

  if (result.sourceFacts.length > 0) {
    console.log("\n  Top contributing facts:");
    for (const f of result.sourceFacts.slice(0, 5)) {
      console.log(`    [${f.id}] (score: ${f.score.toFixed(3)}) ${f.content.slice(0, 100)}...`);
    }
  }

  if (result.savedFact) {
    console.log(`\n  Saved as fact: ${result.savedFact.id}`);
  }
}

// ─── Claude Code Integration ──────────────────────────────────

async function cmdInstallHooks() {
  const { existsSync, readFileSync, writeFileSync } = await import("fs");
  const { resolve, dirname } = await import("path");
  const { execSync } = await import("child_process");

  // Resolve the absolute path to cc-capture.ts
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const capturePath = resolve(projectRoot, "src/cc-capture.ts");

  if (!existsSync(capturePath)) {
    console.error(`Cannot find cc-capture.ts at: ${capturePath}`);
    process.exit(1);
  }

  // Find Claude Code settings
  const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
  const settingsPath = resolve(homeDir, ".claude/settings.json");

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error(`Could not parse ${settingsPath}. Please fix it manually.`);
      process.exit(1);
    }
  }

  // Build the hook command
  const hookCommand = `bun run ${capturePath}`;

  // Ensure hooks structure exists
  if (!settings.hooks) settings.hooks = {};

  // Add SessionEnd hook
  const sessionEndHooks = settings.hooks.SessionEnd || [];
  const alreadyInstalled = sessionEndHooks.some(
    (entry: any) =>
      entry.hooks?.some((h: any) => h.command?.includes("cc-capture"))
  );

  if (alreadyInstalled) {
    console.log("Claude Code session capture hook is already installed.");
    console.log(`Settings file: ${settingsPath}`);
    return;
  }

  sessionEndHooks.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCommand,
        timeout: 30000,
      },
    ],
  });

  settings.hooks.SessionEnd = sessionEndHooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log("Claude Code session capture hook installed!\n");
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Hook:     SessionEnd -> ${hookCommand}`);
  console.log(`\nEvery Claude Code session will now be captured to ira-memory.`);
  console.log(`Run 'bun run src/cli.ts stats' after a session to verify.`);
}

async function cmdCapture(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      transcript: { type: "string" },
      "session-id": { type: "string" },
    },
    strict: false,
  });

  if (!values.transcript) {
    console.error("Usage: capture --transcript /path/to/transcript.jsonl [--session-id ID]");
    process.exit(1);
  }

  // Delegate to cc-capture.ts
  const { execSync } = await import("child_process");
  const { resolve, dirname } = await import("path");
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const capturePath = resolve(projectRoot, "src/cc-capture.ts");

  const captureArgs = [`--transcript`, values.transcript];
  if (values["session-id"]) {
    captureArgs.push("--session-id", values["session-id"]);
  }

  execSync(`bun run ${capturePath} ${captureArgs.join(" ")}`, {
    stdio: "inherit",
  });
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
