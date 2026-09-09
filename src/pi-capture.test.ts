// Fixture-driven test for pi-capture.ts's parsing logic: thinking blocks
// dropped (D1), off-path branch tagging (D3), redaction before store (D8),
// idempotent re-import. Requires a live Postgres (uses the real store), same
// as test-e2e.ts — not a pure-function test like slug.test.ts.

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./client.js";
import { flushPendingEmbeds } from "./embed.js";

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
  // pi-capture.ts validates sessionFile is under SESSIONS_ROOT
  // (~/.pi/agent/sessions/) — build the fixture there rather than in a
  // generic tmp dir, or importPiSession will reject the path outright.
  const { SESSIONS_ROOT, importPiSession } = await import("./pi-capture.js");
  const fixtureDir = mkdtempSync(join(SESSIONS_ROOT, "test-fixture-"));
  const sessionId = `test-${Date.now()}`;
  const file = join(fixtureDir, `${sessionId}.jsonl`);

  // Tree shape (extended for Phase 4: tool calls + tool results):
  //   root(user) -> a1(assistant: thinking+text+toolCall tc1)
  //     -> tr1(toolResult for tc1 — contains a secret, real bug: this is
  //            where the ONE actual secret found in Phase 3 backfill lived,
  //            in a tool result, not in assistant prose)
  //       -> b1(user "abandoned branch") [off-path sibling of the a2 chain]
  //       -> a2(user "the real second turn") -> a4(assistant: toolCall tc2
  //            ONLY, no visible text — tests that a text-less assistant turn
  //            still yields a tool-call row even though it yields no text row)
  //         -> tr2(toolResult for tc2, OVERSIZED — tests the 2KB cap)
  //           -> a3(assistant, has its own secret) [LEAF]
  const OVERSIZED_RESULT = "line of tool output ".repeat(150); // ~3000 chars, > MAX_TOOLRESULT_CHARS (2000)
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/Users/hus/Projects/ira-memory" }),
    JSON.stringify({
      type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello, this is definitely more than fifty characters long for embedding" },
    }),
    JSON.stringify({
      type: "message", id: "a1", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning that must never be stored per D1, padded to be long enough to matter for length checks" },
          { type: "text", text: "Here is my visible answer, long enough to pass the fifty character embed gate easily." },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "env | grep API" } },
        ],
      },
    }),
    // Realistic secret in a TOOL RESULT, not assistant prose — mirrors the
    // actual leak found during Phase 3 backfill (an Anthropic session key
    // sitting in a bash toolResult).
    JSON.stringify({
      type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:00:02.500Z",
      message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: false,
        content: [{ type: "text", text: "OPENAI_API_KEY=sk-proj-Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr\n" }] },
    }),
    // off-path branch: parented on tr1, but the leaf (a3) does not descend from this.
    JSON.stringify({
      type: "message", id: "b1", parentId: "tr1", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "this branch got abandoned when the user edited their message instead, long enough" },
    }),
    JSON.stringify({
      type: "message", id: "a2", parentId: "tr1", timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", content: "the real second turn that stays on the leaf path, long enough to embed too" },
    }),
    // Assistant turn that is 100% tool call, no visible text — must still
    // yield a tool-call row even though it yields no text row.
    JSON.stringify({
      type: "message", id: "a4", parentId: "a2", timestamp: "2026-01-01T00:00:04.500Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "/tmp/big-log.txt" } }] },
    }),
    JSON.stringify({
      type: "message", id: "tr2", parentId: "a4", timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "toolResult", toolCallId: "tc2", toolName: "read", isError: false,
        content: [{ type: "text", text: OVERSIZED_RESULT }] },
    }),
    // Realistic (high-entropy) fake key — real scanners (Phase 2: betterleaks/
    // gitleaks) reject low-entropy/sequential strings like "abcdefghij..." as
    // non-random, same as they'd reject a real secret-shaped placeholder. A
    // fixture has to look like an actual leaked key to prove the engine works.
    JSON.stringify({
      type: "message", id: "a3", parentId: "tr2", timestamp: "2026-01-01T00:00:05.500Z",
      message: { role: "assistant", content: [{ type: "text", text: "OPENAI_API_KEY=sk-proj-Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr is now set, done." }] },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");

  const result = await importPiSession({ sessionFile: file });
  // root(1) + a1 text(1) + a1 toolCall tc1(1) + tr1(1) + b1(1) + a2(1) +
  // a4 toolCall tc2(1, no text row — a4's own text is empty) + tr2(1) + a3(1) = 9
  assert(result.imported === 9, `imported 9 rows (5 text/user-assistant + 2 tool calls + 2 tool results) — got ${result.imported}`);
  assert(result.skippedEmpty === 1, `a4's own text portion is empty (toolCall-only turn) — got ${result.skippedEmpty}`);
  assert(result.project === "ira-memory", `project resolved from cwd — got ${result.project}`);

  const rows = await prisma.message.findMany({
    where: { sessionId: result.sessionRowId },
    orderBy: { createdAt: "asc" },
  });

  const byEntryId = new Map(rows.map((r) => [(r.metadata as any)?.piEntryId, r]));

  const rootRow = byEntryId.get("root");
  assert(rootRow?.role === "user", "root: role is user");
  assert(!(rootRow?.metadata as any)?.offPath, "root: on leaf path");

  const a1Row = byEntryId.get("a1");
  assert(a1Row?.role === "assistant", "a1: role is assistant");
  assert(!!a1Row?.content.includes("visible answer"), "a1: visible text stored");
  assert(!a1Row?.content.includes("internal reasoning"), "a1: thinking block dropped (D1)");
  assert(!a1Row?.content.includes("bash"), "a1: toolCall not stored as text (Phase 4 scope)");
  assert(!(a1Row?.metadata as any)?.offPath, "a1: on leaf path");

  const b1Row = byEntryId.get("b1");
  assert(b1Row?.role === "user", "b1: still imported despite being off-path (D3)");
  assert((b1Row?.metadata as any)?.offPath === true, "b1: tagged offPath=true (D3)");

  const a2Row = byEntryId.get("a2");
  assert(!(a2Row?.metadata as any)?.offPath, "a2: on leaf path (not off-path)");

  const a3Row = byEntryId.get("a3");
  assert(!!a3Row && !a3Row.content.includes("Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr"), "a3: secret redacted before store (D8)");
  assert(!!a3Row?.content.includes("[REDACTED]"), "a3: redaction placeholder present");
  assert((a3Row?.metadata as any)?.redacted === true, "a3: metadata.redacted=true");
  const engine = (a3Row?.metadata as any)?.redactionEngine as string | undefined;
  const validEngines = ["betterleaks", "gitleaks", "heuristic", "betterleaks+heuristic", "gitleaks+heuristic"];
  assert(!!engine && validEngines.includes(engine), `a3: metadata.redactionEngine is a real tier — got ${engine}`);

  // --- Phase 4: tool call row (tc1, inside a1) ---
  const tc1Row = byEntryId.get("a1:call:tc1");
  assert(tc1Row?.role === "assistant", "tc1: role is assistant (it's part of the assistant's turn)");
  assert(tc1Row?.toolName === "bash", "tc1: toolName=bash");
  assert(!!tc1Row?.content.includes("bash"), "tc1: content is a searchable marker naming the tool");
  assert(tc1Row?.toolInput === tc1Row?.content, "tc1: toolInput mirrors the redacted content (same safe value, structured column too)");
  assert((tc1Row?.metadata as any)?.piEntryId === "a1:call:tc1", "tc1: synthetic piEntryId distinct from a1's own text row");

  // --- Phase 4: tool result row (tr1) — the actual secret lived here in the real bug ---
  const tr1Row = byEntryId.get("tr1");
  assert(tr1Row?.role === "tool", "tr1: role is tool");
  assert(tr1Row?.toolName === "bash", "tr1: toolName copied from the toolResult entry");
  assert(!!tr1Row && !tr1Row.content.includes("Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr"), "tr1: secret in a TOOL RESULT is also redacted (this is the real bug this phase closes)");
  assert((tr1Row?.metadata as any)?.redacted === true, "tr1: metadata.redacted=true");
  assert((tr1Row?.toolOutput as any)?.isError === false, "tr1: toolOutput.isError carried through");

  // --- Phase 4: tool call with NO sibling text row (a4 was 100% tool call) ---
  const tc2Row = byEntryId.get("a4:call:tc2");
  assert(tc2Row?.toolName === "read", "tc2: toolName=read, imported even though a4 produced no text row");
  assert(!byEntryId.has("a4"), "a4: no text row exists at all (its own piEntryId was never stored — only the synthetic call row was)");

  // --- Phase 4: oversized tool result gets capped, original length recorded ---
  const tr2Row = byEntryId.get("tr2");
  assert(tr2Row!.content.length <= 2000, `tr2: capped at IRA_PI_TOOLRESULT_CAP (2000) — got ${tr2Row!.content.length}`);
  // trim() runs before capping (extractText().trim()), so the recorded length is the trimmed size, not the raw repeat() length.
  assert((tr2Row?.metadata as any)?.originalLength === OVERSIZED_RESULT.trim().length, `tr2: metadata.originalLength records the pre-cap (trimmed) size — got ${(tr2Row?.metadata as any)?.originalLength}`);

  // --- Phase 4: tool rows are never embedded (plan: "tool results never embedded") ---
  await flushPendingEmbeds();
  const toolRowIds = [tc1Row!.id, tr1Row!.id, tc2Row!.id, tr2Row!.id];
  const toolEmbeds = await prisma.messageEmbedding.count({ where: { messageId: { in: toolRowIds } } });
  assert(toolEmbeds === 0, `no tool-call or tool-result row was embedded — got ${toolEmbeds} embeddings across ${toolRowIds.length} tool rows`);

  // Idempotent re-import: same file, no new rows.
  const second = await importPiSession({ sessionFile: file });
  assert(second.imported === 0, `re-import adds nothing new — got ${second.imported}`);
  assert(second.skippedExisting === 9, `re-import skips all 9 as already-imported — got ${second.skippedExisting}`);

  // final: true closes the session.
  await importPiSession({ sessionFile: file, final: true });
  const closed = await prisma.session.findUnique({ where: { id: result.sessionRowId } });
  assert(closed?.endedAt !== null, "final:true sets endedAt");

  // Cleanup
  await flushPendingEmbeds();
  await prisma.message.deleteMany({ where: { sessionId: result.sessionRowId } });
  await prisma.session.delete({ where: { id: result.sessionRowId } });
  rmSync(fixtureDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

// Top-level await, not fire-and-forget: `bun test` moves on once a file's
// module body returns, and an unawaited async main() had its output silently
// dropped as a result — see redact.test.ts for the full explanation.
await main()
  .catch((err) => {
    console.error("fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
