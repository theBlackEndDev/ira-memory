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
      const [sessionId] = args;
      try {
        // Get recent facts: active TODOs, PLANs, recent DECISIONs, and PROJECT_STATE
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const results = await recall({
          categories: ["TODO", "PLAN", "DECISION", "PROJECT_STATE"],
          timeRange: { after: yesterday },
          limit: 15,
        });

        // Also get LONG_TERM preferences and context
        const longTerm = await recall({
          tier: "LONG_TERM",
          categories: ["PREFERENCE", "CONTEXT", "DECISION"],
          limit: 10,
        });

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
