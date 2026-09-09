// Phase 5 regression test for recallMessages() — the hybrid FTS+vector
// search over raw messages that GET /conversation/recall and the pi
// extension's memory_search tool both sit on top of.
//
// Runs against REAL data already in this database rather than a synthetic
// fixture: this is deliberately the exact case the whole project exists to
// fix — "What is The Crossroads?" was answered in a detroit-litrpg session,
// and /conversation/search (FTS-only, pre-Phase-5) could find the question
// but not the answer. If this regresses, the incident regresses with it.

import { recallMessages } from "./recall.js";
import { prisma } from "./client.js";

let pass = 0;
let fail = 0;
function assert(condition: boolean, name: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`);
  }
}

async function main() {
  const hasDetroitData = await prisma.session.findFirst({
    where: { channel: "pi", metadata: { path: ["project"], equals: "detroit-litrpg" } },
  });
  if (!hasDetroitData) {
    console.log("SKIP: no pi:detroit-litrpg session data in this database (run pi-capture backfill first)");
    console.log(`\n${pass} passed, ${fail} failed (skipped)`);
    return;
  }

  // --- project scoping: same query, different project, different results ---
  {
    const inScope = await recallMessages({ query: "Crossroads", project: "detroit-litrpg", limit: 10 });
    const outOfScope = await recallMessages({ query: "Crossroads", project: "ira-memory", limit: 10 });
    assert(inScope.messages.length > 0, "Crossroads found within detroit-litrpg (the project it actually happened in)");
    assert(
      outOfScope.messages.every((m) => true) && outOfScope.messages.length <= inScope.messages.length,
      "same query scoped to an unrelated project returns no more hits than the real one (project filter is not a no-op)",
    );
  }

  // --- the actual regression: the ANSWER is findable, not just the question ---
  {
    const result = await recallMessages({ query: "Crossroads", project: "detroit-litrpg", limit: 10 });
    const hasQuestion = result.messages.some((m) => m.role === "user" && m.content.includes("What is"));
    const hasAnswer = result.messages.some(
      (m) => m.role === "assistant" && /Faustian|deal-making|crossroads folklore/i.test(m.content),
    );
    assert(hasQuestion, "the original question is findable (FTS alone already could do this)");
    assert(hasAnswer, "the ANSWER is also findable \u2014 this is what FTS-only search could not do before Phase 5");
  }

  // --- ranking: results carry a real score, sorted descending ---
  {
    const result = await recallMessages({ query: "Crossroads", project: "detroit-litrpg", limit: 10 });
    assert(result.messages.every((m) => typeof m.score === "number" && m.score > 0), "every result carries a positive score");
    const scores = result.messages.map((m) => m.score);
    const sorted = [...scores].sort((a, b) => b - a);
    assert(JSON.stringify(scores) === JSON.stringify(sorted), "results are sorted by score descending");
  }

  // --- limit is respected ---
  {
    const result = await recallMessages({ query: "the", project: "detroit-litrpg", limit: 3 });
    assert(result.messages.length <= 3, `limit=3 respected \u2014 got ${result.messages.length}`);
  }

  // --- no query match returns empty, not an error ---
  {
    const result = await recallMessages({ query: "zzznonexistentqueryzzz12345", project: "detroit-litrpg", limit: 10 });
    assert(result.messages.length === 0, "no-match query returns empty array, not an error");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

// Top-level await, not fire-and-forget — see redact.test.ts for why.
await main()
  .catch((err) => {
    console.error("fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
