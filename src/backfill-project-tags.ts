#!/usr/bin/env bun
/**
 * backfill-project-tags.ts — Retroactively tag existing memory facts with
 * `project:<slug>` based on the originating session's metadata.cwd.
 *
 * Operates idempotently: facts already carrying the right tag are skipped.
 * No LLM calls, no content mutation — pure metadata update.
 *
 * Usage:
 *   bun run src/backfill-project-tags.ts [--project <slug>] [--dry-run]
 *
 * Flags:
 *   --project <slug>   Only process sessions whose cwd resolves to this slug.
 *                      Omit to process all projects in one pass.
 *   --dry-run          Report what would change without writing.
 */
import { prisma } from "./client.js";

interface SessionRow {
  id: string;
  metadata: unknown;
}

function deriveSlug(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const m = cwd.match(/\/orchestrator\/projects\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const projIdx = argv.indexOf("--project");
  const targetSlug = projIdx !== -1 ? argv[projIdx + 1] : null;

  const sessions: SessionRow[] = await prisma.session.findMany({
    select: { id: true, metadata: true },
  });

  const groups = new Map<string, string[]>();
  for (const s of sessions) {
    const cwd = (s.metadata as { cwd?: string } | null)?.cwd;
    const slug = deriveSlug(cwd);
    if (!slug) continue;
    if (targetSlug && slug !== targetSlug) continue;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug)!.push(s.id);
  }

  const totalGroups = groups.size;
  if (totalGroups === 0) {
    console.log(targetSlug
      ? `No sessions found for project "${targetSlug}".`
      : "No slug-derivable sessions found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Backfilling project tags${dryRun ? " (DRY-RUN)" : ""}`);
  console.log(`Groups: ${totalGroups}  Sessions: ${[...groups.values()].reduce((a, b) => a + b.length, 0)}\n`);

  let totalChecked = 0;
  let totalTagged = 0;
  let totalAlreadyTagged = 0;

  for (const [slug, sessionIds] of groups) {
    const tag = `project:${slug}`;
    const facts = await prisma.memoryFact.findMany({
      where: { sourceRef: { in: sessionIds } },
      select: { id: true, tags: true, content: true },
    });
    totalChecked += facts.length;

    let tagged = 0;
    let already = 0;
    for (const f of facts) {
      if (f.tags.includes(tag)) { already++; continue; }
      if (!dryRun) {
        await prisma.memoryFact.update({
          where: { id: f.id },
          data: { tags: { push: tag } },
        });
      }
      tagged++;
    }
    totalTagged += tagged;
    totalAlreadyTagged += already;
    console.log(
      `  ${slug.padEnd(24)} sessions=${sessionIds.length.toString().padStart(3)} ` +
      `facts=${facts.length.toString().padStart(4)} ` +
      `newly-tagged=${tagged.toString().padStart(4)} ` +
      `already-tagged=${already.toString().padStart(4)}`
    );
  }

  console.log();
  console.log(`TOTAL  facts checked: ${totalChecked}  newly tagged: ${totalTagged}  already tagged: ${totalAlreadyTagged}`);

  // ── Second pass: tag manually-POSTed facts (no sourceRef) by content prefix.
  // These come from /memory POST and never had session.metadata.cwd to derive
  // from, but if their content starts with `[<slug>] ` we can tag retroactively.
  console.log("\nContent-prefix pass (facts with [<slug>] in content):");
  const slugsToCheck = targetSlug ? [targetSlug] : [...groups.keys()];
  let prefixTagged = 0;
  for (const slug of slugsToCheck) {
    const tag = `project:${slug}`;
    const prefix = `[${slug}]`;
    const facts = await prisma.memoryFact.findMany({
      where: {
        content: { startsWith: prefix },
        NOT: { tags: { has: tag } },
      },
      select: { id: true },
    });
    if (facts.length === 0) {
      console.log(`  ${slug.padEnd(24)} no prefix-only facts`);
      continue;
    }
    if (!dryRun) {
      for (const f of facts) {
        await prisma.memoryFact.update({
          where: { id: f.id },
          data: { tags: { push: tag } },
        });
      }
    }
    prefixTagged += facts.length;
    console.log(`  ${slug.padEnd(24)} prefix-tagged=${facts.length}`);
  }
  console.log(`\nContent-prefix newly tagged: ${prefixTagged}`);
  if (dryRun) console.log("(dry-run — no changes written)");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
