#!/usr/bin/env bun
/**
 * redact-rescan.ts — one-off remediation + reusable maintenance tool.
 *
 * Re-runs the current redaction engine chain (redact.ts) against every
 * EXISTING message's content and updates any row where the result changed.
 * Needed because pi-capture.ts's redaction only runs at import time — if the
 * engine chain improves later (as it did here: the waterfall-only design
 * missed a real Anthropic key that the corrected composed design catches),
 * rows already in Postgres from before the fix stay unredacted until
 * something re-scans them. This is that something.
 *
 * Safe to re-run any time the engine chain changes. Idempotent: a row whose
 * content is already fully redacted comes back unchanged and is skipped.
 *
 * Usage: bun run src/redact-rescan.ts [--dry-run]
 */

import { prisma } from "./client.js";
import { redactBatch } from "./redact.js";
import { flushPendingEmbeds } from "./embed.js";

const BATCH_SIZE = 50;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = await prisma.message.findMany({ select: { id: true, content: true, metadata: true } });
  console.error(`[redact-rescan] scanning ${rows.length} messages${dryRun ? " (dry run)" : ""}`);

  let changed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const batch = await redactBatch(chunk.map((r) => r.content));
    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      if (batch.texts[j] === row.content) continue; // no change, nothing to do
      changed++;
      console.error(`[redact-rescan] ${row.id}: content changed (engine=${batch.engine}, count=${batch.counts[j]})`);
      if (!dryRun) {
        const meta = (row.metadata as Record<string, unknown> | null) ?? {};
        await prisma.message.update({
          where: { id: row.id },
          data: {
            content: batch.texts[j],
            metadata: { ...meta, redacted: true, redactionEngine: batch.engine, redactionCount: batch.counts[j], reRedactedAt: new Date().toISOString() },
          },
        });
      }
    }
  }

  console.error(`[redact-rescan] done: ${changed} row(s) ${dryRun ? "would be" : "were"} updated out of ${rows.length}`);
}

main()
  .catch((err) => {
    console.error("[redact-rescan] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushPendingEmbeds();
    await prisma.$disconnect();
  });
