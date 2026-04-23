#!/usr/bin/env bun
/**
 * hook-bridge.ts - Bridge between IRA hooks and the memory database.
 *
 * Called by hook scripts via: bun run <this-file> <command> [args...]
 *
 * Commands:
 *   session-open   <channel> [title] [agentId]  → stdout: sessionId
 *   session-close  <sessionId>                   → closes session + summary
 *   message-store  <sessionId> <role> <content>  → stores message
 *   recall-context [sessionId]                   → stdout: JSON context for injection
 *
 * All errors go to stderr. Non-fatal — always exits 0.
 */

import {
  openSession,
  closeSession,
  storeMessage,
  recall,
  flushPendingEmbeds,
  prisma,
} from "./index.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "session-open": {
      const [channel = "cli", title, agentId] = args;
      const session = await openSession({
        channel,
        title: title || undefined,
        agentId: agentId || undefined,
        hostId: process.env.HOSTNAME || undefined,
      });
      // Output just the session ID for the hook to capture
      process.stdout.write(session.id);
      break;
    }

    case "session-close": {
      const [sessionId] = args;
      if (!sessionId) break;
      try {
        await closeSession(sessionId);
      } catch (err) {
        console.error(`[hook-bridge] session-close error: ${err}`);
      }
      break;
    }

    case "message-store": {
      const [sessionId, role, ...contentParts] = args;
      if (!sessionId || !role) break;
      const content = contentParts.join(" ");
      if (!content || content.length < 2) break;
      try {
        await storeMessage({
          sessionId,
          role: role as "user" | "assistant" | "system" | "tool",
          content: content.slice(0, 50000), // Cap at 50k chars
        });
      } catch (err) {
        console.error(`[hook-bridge] message-store error: ${err}`);
      }
      break;
    }

    case "recall-context": {
      const [sessionId, projectSlug] = args;
      try {
        // Get recent facts: active TODOs, PLANs, recent DECISIONs, and PROJECT_STATE
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // If a projectSlug is passed (e.g. "faceless-youtube"), scope recall to it
        // through three independent signals (merged, dedup'd):
        //   1. tags: ["project:<slug>"]  — new facts written by summarize.ts
        //   2. query: "<slug with spaces>" — FTS + semantic (covers pre-tag data)
        //   3. content prefix "[<slug>]" — FTS fallback
        // Project-less calls stay global (back-compat).
        const hasProject = projectSlug && projectSlug !== "-";
        const projectQuery = hasProject ? projectSlug.replace(/-/g, " ") : undefined;
        const projectTag = hasProject ? [`project:${projectSlug}`] : undefined;

        // Two passes — one tag-based (strict), one query-based (loose) — to
        // catch both tagged-by-summarize facts AND older untagged facts whose
        // content mentions the project slug.
        const recentTagged = hasProject ? await recall({
          categories: ["TODO", "PLAN", "DECISION", "PROJECT_STATE"],
          timeRange: { after: yesterday },
          limit: 10,
          tags: projectTag,
        }) : { facts: [], summaries: [] };

        const recentQueried = await recall({
          categories: ["TODO", "PLAN", "DECISION", "PROJECT_STATE"],
          timeRange: { after: yesterday },
          limit: 15,
          ...(projectQuery && { query: projectQuery }),
        });

        // Merge + dedup by id
        const seenRecent = new Set<string>();
        const mergedRecentFacts = [...recentTagged.facts, ...recentQueried.facts]
          .filter((f) => !seenRecent.has(f.id) && seenRecent.add(f.id))
          .slice(0, 15);
        const mergedRecentSummaries = [
          ...recentTagged.summaries,
          ...recentQueried.summaries,
        ].filter((s) => !seenRecent.has(s.id) && seenRecent.add(s.id));
        const results = { facts: mergedRecentFacts, summaries: mergedRecentSummaries };

        // Long-term — same two-pass merge
        const longTermTagged = hasProject ? await recall({
          tier: "LONG_TERM",
          categories: ["PREFERENCE", "CONTEXT", "DECISION", "LESSON"],
          limit: 8,
          tags: projectTag,
        }) : { facts: [] };

        const longTermQueried = await recall({
          tier: "LONG_TERM",
          categories: ["PREFERENCE", "CONTEXT", "DECISION", "LESSON"],
          limit: 10,
          ...(projectQuery && { query: projectQuery }),
        });

        const seenLong = new Set<string>();
        const longTermFacts = [...longTermTagged.facts, ...longTermQueried.facts]
          .filter((f) => !seenLong.has(f.id) && seenLong.add(f.id))
          .slice(0, 12);
        const longTerm = { facts: longTermFacts };

        const contextParts: string[] = [];

        if (longTerm.facts.length > 0) {
          contextParts.push("[IRA DB MEMORY — Long-term]");
          for (const f of longTerm.facts) {
            contextParts.push(`- [${f.category}] ${f.content}`);
          }
        }

        if (results.facts.length > 0) {
          contextParts.push("\n[IRA DB MEMORY — Recent (24h)]");
          for (const f of results.facts) {
            contextParts.push(`- [${f.category}] ${f.content}`);
          }
        }

        if (results.summaries.length > 0) {
          contextParts.push("\n[IRA DB MEMORY — Recent Summaries]");
          for (const s of results.summaries) {
            contextParts.push(`- [${s.scope}] ${s.content.slice(0, 200)}`);
          }
        }

        if (contextParts.length > 0) {
          process.stdout.write(contextParts.join("\n"));
        }
      } catch (err) {
        console.error(`[hook-bridge] recall-context error: ${err}`);
      }
      break;
    }

    case "learn": {
      const [sessionId] = args;
      if (!sessionId) break;
      try {
        const { learn } = await import("./learn.js");
        const result = await learn({ sessionId, dedup: true, minConfidence: 0.7 });
        process.stdout.write(
          JSON.stringify({ learnings: result.totalExtracted, skipped: result.skipped })
        );
      } catch (err) {
        console.error(`[hook-bridge] learn error: ${err}`);
      }
      break;
    }

    case "recall-learnings": {
      try {
        const learnings = await recall({
          tier: "LONG_TERM",
          limit: 20,
        });
        // Filter to facts with learningType set
        const learningFacts = learnings.facts.filter(
          (f) => (f as any).learningType != null
        );
        if (learningFacts.length > 0) {
          const parts = ["\n[IRA DB MEMORY — Learnings]"];
          for (const f of learningFacts) {
            parts.push(`- [${(f as any).learningType}] ${f.content}`);
          }
          process.stdout.write(parts.join("\n"));
        }
      } catch (err) {
        console.error(`[hook-bridge] recall-learnings error: ${err}`);
      }
      break;
    }

    default:
      console.error(`[hook-bridge] Unknown command: ${command}`);
  }
}

main()
  .catch((err) => console.error(`[hook-bridge] Fatal: ${err}`))
  .finally(async () => {
    await flushPendingEmbeds();
    await prisma.$disconnect();
  });
