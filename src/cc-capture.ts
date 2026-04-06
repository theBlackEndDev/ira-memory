#!/usr/bin/env bun
/**
 * cc-capture.ts - Claude Code SessionEnd hook for capturing conversations.
 *
 * Reads the CC hook JSON from stdin, parses the transcript.jsonl,
 * and bulk-imports user/assistant messages into ira-memory.
 *
 * Usage (called automatically by Claude Code SessionEnd hook):
 *   echo '{"session_id":"...","transcript_path":"..."}' | bun run src/cc-capture.ts
 *
 * Can also be run manually to import a transcript:
 *   bun run src/cc-capture.ts --transcript /path/to/transcript.jsonl --session-id abc123
 */

import { readFileSync } from "fs";
import { hostname } from "os";
import { openSession, closeSession, storeMessage, prisma } from "./index.js";

interface CCHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
}

interface TranscriptLine {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    model?: string;
  };
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
}

function extractContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

async function main() {
  let ccSessionId: string;
  let transcriptPath: string;
  let cwd = process.cwd();

  // Parse args: either from stdin (hook mode) or CLI flags (manual mode)
  const args = process.argv.slice(2);
  const manualIdx = args.indexOf("--transcript");

  if (manualIdx !== -1) {
    // Manual mode
    transcriptPath = args[manualIdx + 1];
    const sidIdx = args.indexOf("--session-id");
    ccSessionId = sidIdx !== -1 ? args[sidIdx + 1] : `manual-${Date.now()}`;
  } else {
    // Hook mode: read JSON from stdin
    const input = readFileSync("/dev/stdin", "utf-8").trim();
    if (!input) {
      process.exit(0);
    }
    const hookInput: CCHookInput = JSON.parse(input);
    ccSessionId = hookInput.session_id;
    transcriptPath = hookInput.transcript_path;
    cwd = hookInput.cwd || cwd;

    if (!transcriptPath) {
      console.error("[cc-capture] No transcript_path in hook input");
      process.exit(0);
    }
  }

  // Read and parse transcript
  let transcriptData: string;
  try {
    transcriptData = readFileSync(transcriptPath, "utf-8");
  } catch (err) {
    console.error(`[cc-capture] Cannot read transcript: ${err}`);
    process.exit(0);
  }

  const lines = transcriptData
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as TranscriptLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is TranscriptLine => l !== null);

  // Extract user and assistant messages
  const messages: Array<{
    role: "user" | "assistant";
    content: string;
    model?: string;
    timestamp?: string;
  }> = [];

  for (const line of lines) {
    if (line.type === "user" && line.message?.role === "user") {
      const content = extractContent(line.message.content);
      if (content && content.length >= 2) {
        messages.push({
          role: "user",
          content,
          timestamp: line.timestamp,
        });
      }
    } else if (
      (line.type === "assistant" || line.type === "result") &&
      line.message?.role === "assistant"
    ) {
      const content = extractContent(line.message.content);
      if (content && content.length >= 2) {
        messages.push({
          role: "assistant",
          content,
          model: line.message.model,
          timestamp: line.timestamp,
        });
      }
    }
  }

  if (messages.length === 0) {
    // Nothing to capture (e.g., empty session or only tool calls)
    process.exit(0);
  }

  // Check if this CC session was already imported (idempotency)
  const existing = await prisma.session.findFirst({
    where: { metadata: { path: ["ccSessionId"], equals: ccSessionId } },
  });

  if (existing) {
    // Already imported
    process.exit(0);
  }

  // Derive a title from the first user message
  const firstMsg = messages.find((m) => m.role === "user");
  const title = firstMsg
    ? firstMsg.content.slice(0, 80) + (firstMsg.content.length > 80 ? "..." : "")
    : "Claude Code session";

  // Open session
  const session = await openSession({
    channel: "claude-code",
    title,
    hostId: hostname(),
    metadata: {
      ccSessionId,
      cwd,
      capturedAt: new Date().toISOString(),
      messageCount: messages.length,
    },
  });

  // Store messages
  for (const msg of messages) {
    await storeMessage({
      sessionId: session.id,
      role: msg.role,
      content: msg.content.slice(0, 50000), // Cap at 50k chars
      model: msg.model,
    });
  }

  // Close session (triggers auto-summary + learning extraction)
  try {
    await closeSession(session.id);
  } catch (err) {
    console.error(`[cc-capture] closeSession error (non-fatal): ${err}`);
  }

  console.error(
    `[cc-capture] Captured ${messages.length} messages from CC session ${ccSessionId.slice(0, 8)}...`
  );
}

main()
  .catch((err) => console.error(`[cc-capture] Fatal: ${err}`))
  .finally(() => prisma.$disconnect());
