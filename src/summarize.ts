import { prisma } from "./client.js";
import { embedSummaryAsync } from "./embed.js";
import { getClient, CHAT_MODEL } from "./llm.js";
import type { Summary, SummaryScope } from "./types.js";

// null when IRA_LLM_PROVIDER=none → summary functions fall back to extractive (no LLM) summaries.
const openai = getClient();

export interface SummarizeInput {
  scope: SummaryScope;
  sessionId?: string;
  periodStart?: Date;
  periodEnd?: Date;
  projectName?: string;
}

/**
 * Generate a summary for a session, day, week, or project.
 */
export async function summarize(input: SummarizeInput): Promise<Summary> {
  let content: string;
  let periodStart: Date;
  let periodEnd: Date;
  let keyTopics: string[];
  let factIds: string[];

  switch (input.scope) {
    case "SESSION":
      ({ content, periodStart, periodEnd, keyTopics, factIds } =
        await summarizeSession(input.sessionId!));
      break;
    case "DAILY":
      ({ content, periodStart, periodEnd, keyTopics, factIds } =
        await summarizeDaily(input.periodStart!));
      break;
    case "WEEKLY":
      ({ content, periodStart, periodEnd, keyTopics, factIds } =
        await summarizeWeekly(input.periodStart!));
      break;
    case "PROJECT":
      ({ content, periodStart, periodEnd, keyTopics, factIds } =
        await summarizeProject(input.projectName!, input.periodStart, input.periodEnd));
      break;
    default:
      throw new Error(`Unknown scope: ${input.scope}`);
  }

  const summary = await prisma.summary.create({
    data: {
      scope: input.scope,
      sessionId: input.sessionId,
      periodStart,
      periodEnd,
      content,
      keyTopics,
      factIds,
    },
  });

  // Async embed the summary
  embedSummaryAsync(summary.id);

  return summary;
}

/**
 * Derive a project slug from a session's cwd. This is the one shared
 * algorithm — the pi extension's `slug.ts` (projectSlugForCwd) must implement
 * the same three rules in the same order; a parity test in both repos checks
 * they agree (plan: pi-ira-memory-capture.md D2).
 *
 * Recognized (immediate child of a projects dir, returned verbatim):
 *   /orchestrator/projects/<slug>/...   (server layout)
 *   ~/Projects/<slug>/...               (home layout, e.g. macOS)
 * Nested repos (~/Projects/parent/child) resolve to <parent> — coarser but stable,
 * which is enough to keep distinct projects' memory from bleeding together.
 *
 * cwd is exactly a projects root ("~/Projects", "/orchestrator/projects", with
 * or without a trailing slash) → "Projects", the deliberate catch-all for
 * general sessions that aren't inside any specific project (locked decision,
 * not a bug — see plan §3.4). No home directory is hardcoded: this matches on
 * the path's last segment being literally "projects", so it works for any
 * user or host layout.
 *
 * Anything else (no "projects" segment at all, e.g. `~/.pi/agent/extensions/x`)
 * falls back to `basename(cwd)` rather than null. Before this fallback existed,
 * every session outside a Projects folder was silently uncaptured — this is
 * the fix for that blind spot, not just a pi-specific tweak.
 */
export function deriveProjectSlug(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return null;
  if (/(^|\/)[Pp]rojects$/.test(trimmed)) return "Projects";
  const segmentMatch = cwd.match(/\/[Pp]rojects\/([^/]+)(?:\/|$)/);
  if (segmentMatch) return segmentMatch[1];
  const base = trimmed.split("/").pop();
  return base || null;
}

async function summarizeSession(sessionId: string) {
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
  });

  const messages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });

  if (messages.length === 0) {
    return {
      content: "Empty session - no messages.",
      periodStart: session.startedAt,
      periodEnd: session.endedAt ?? new Date(),
      keyTopics: [] as string[],
      factIds: [] as string[],
    };
  }

  // Build conversation text for LLM (truncate to ~12000 chars)
  let convoText = "";
  for (const msg of messages) {
    const line = `[${msg.role}]: ${msg.content}\n`;
    if (convoText.length + line.length > 12000) {
      convoText += "\n[...truncated...]\n";
      break;
    }
    convoText += line;
  }

  // No LLM (IRA_LLM_PROVIDER=none) → extractive fallback: keep the (truncated) transcript as the
  // summary, no fact extraction. The raw turns remain fully searchable via FTS.
  if (!openai) {
    return {
      content: convoText.slice(0, 2000),
      periodStart: session.startedAt,
      periodEnd: session.endedAt ?? new Date(),
      keyTopics: [] as string[],
      factIds: [] as string[],
    };
  }

  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You summarize conversations for a memory system. Given a conversation, produce:
1. A concise summary (2-4 paragraphs, under 500 words)
2. Key topics as a JSON array of strings
3. Extracted facts as a JSON array of objects with {category, content} where category is one of: PREFERENCE, DECISION, PLAN, TODO, FACT, LESSON, CONTEXT, PROJECT_STATE

Respond in this exact JSON format:
{"summary": "...", "topics": ["..."], "facts": [{"category": "...", "content": "..."}]}`,
      },
      {
        role: "user",
        content: `Summarize this conversation:\n\n${convoText}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  // Store extracted facts
  const VALID_CATEGORIES = new Set([
    "PREFERENCE", "DECISION", "PLAN", "TODO", "FACT", "LESSON",
    "CHECKPOINT", "CONTEXT", "TOOL_CONFIG", "PROJECT_STATE",
  ]);

  // Derive project slug from session.metadata.cwd so facts + summary inherit
  // the project scope. This lets recall-context filter by `project:<slug>` tag
  // AND the slug appears in content so FTS/semantic query also match.
  const sessionMeta = (session.metadata as { cwd?: string } | null) ?? null;
  const projectSlug = deriveProjectSlug(sessionMeta?.cwd ?? null);
  const projectTag = projectSlug ? `project:${projectSlug}` : null;

  const storedFactIds: string[] = [];
  if (parsed.facts && Array.isArray(parsed.facts)) {
    for (const fact of parsed.facts) {
      try {
        // Validate category from LLM — fall back to FACT if invalid
        const category = VALID_CATEGORIES.has(fact.category) ? fact.category : "FACT";
        const baseTags = ["session-summary"];
        const tags = projectTag ? [...baseTags, projectTag] : baseTags;
        // Prepend project slug to content for FTS/semantic matching on the slug.
        const content = projectSlug
          ? `[${projectSlug}] ${fact.content}`
          : fact.content;
        const stored = await prisma.memoryFact.create({
          data: {
            category,
            tier: "SHORT_TERM",
            content,
            source: "inferred",
            sourceRef: sessionId,
            confidence: 0.8,
            tags,
          },
        });
        storedFactIds.push(stored.id);
      } catch {
        // Skip invalid facts
      }
    }
  }

  return {
    content: parsed.summary ?? "Failed to generate summary.",
    periodStart: session.startedAt,
    periodEnd: session.endedAt ?? new Date(),
    keyTopics: (parsed.topics as string[]) ?? [],
    factIds: storedFactIds,
  };
}

async function summarizeDaily(date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  // Get session summaries for this day
  const sessionSummaries = await prisma.summary.findMany({
    where: {
      scope: "SESSION",
      periodStart: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { periodStart: "asc" },
  });

  // Also get any facts created today
  const todayFacts = await prisma.memoryFact.findMany({
    where: {
      isArchived: false,
      createdAt: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const inputText = [
    "Session summaries for the day:",
    ...sessionSummaries.map((s, i) => `\nSession ${i + 1}:\n${s.content}`),
    "\nKey facts recorded today:",
    ...todayFacts.map((f) => `- [${f.category}] ${f.content}`),
  ].join("\n");

  if (!openai) {
    return { content: inputText.slice(0, 2000), periodStart: dayStart, periodEnd: dayEnd, keyTopics: [] as string[], factIds: todayFacts.map((f) => f.id) };
  }

  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You create daily summaries for a memory system. Given the day's session summaries and facts, produce:
1. A daily summary (1-2 paragraphs, under 300 words) focusing on what was accomplished, key decisions, and open items
2. Key topics as a JSON array

Respond in this exact JSON format:
{"summary": "...", "topics": ["..."]}`,
      },
      { role: "user", content: inputText },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  return {
    content: parsed.summary ?? "No activity for this day.",
    periodStart: dayStart,
    periodEnd: dayEnd,
    keyTopics: (parsed.topics as string[]) ?? [],
    factIds: todayFacts.map((f) => f.id),
  };
}

async function summarizeWeekly(weekStart: Date) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const dailySummaries = await prisma.summary.findMany({
    where: {
      scope: "DAILY",
      periodStart: { gte: start, lt: end },
    },
    orderBy: { periodStart: "asc" },
  });

  const inputText = dailySummaries
    .map((s) => `${s.periodStart.toISOString().split("T")[0]}:\n${s.content}`)
    .join("\n\n");

  if (!openai) {
    return { content: inputText.slice(0, 2000), periodStart: start, periodEnd: end, keyTopics: [] as string[], factIds: [] as string[] };
  }

  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You create weekly summaries for a memory system. Given the week's daily summaries, produce:
1. A weekly summary (1-2 paragraphs) covering key accomplishments, themes, and outstanding items
2. Key topics as a JSON array

Respond in this exact JSON format:
{"summary": "...", "topics": ["..."]}`,
      },
      { role: "user", content: inputText || "No daily summaries available for this week." },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  return {
    content: parsed.summary ?? "No activity for this week.",
    periodStart: start,
    periodEnd: end,
    keyTopics: (parsed.topics as string[]) ?? [],
    factIds: [] as string[],
  };
}

async function summarizeProject(
  projectName: string,
  periodStart?: Date,
  periodEnd?: Date
) {
  const start = periodStart ?? new Date(0);
  const end = periodEnd ?? new Date();

  // Find facts tagged with this project
  const projectFacts = await prisma.memoryFact.findMany({
    where: {
      isArchived: false,
      OR: [
        { tags: { has: projectName } },
        { tags: { has: projectName.toLowerCase() } },
        { content: { contains: projectName, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const inputText = [
    `Project: ${projectName}`,
    `Period: ${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}`,
    "",
    "Related facts and decisions:",
    ...projectFacts.map((f) => `- [${f.category}/${f.tier}] ${f.content}`),
  ].join("\n");

  if (!openai) {
    return { content: inputText.slice(0, 2000), periodStart: start, periodEnd: end, keyTopics: [] as string[], factIds: projectFacts.map((f) => f.id) };
  }

  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You create project-level summaries for a memory system. Given project facts and decisions, produce:
1. A project summary covering current state, key decisions, recent progress, and open items
2. Key topics as a JSON array

Respond in this exact JSON format:
{"summary": "...", "topics": ["..."]}`,
      },
      { role: "user", content: inputText },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  return {
    content: parsed.summary ?? `No data found for project: ${projectName}`,
    periodStart: start,
    periodEnd: end,
    keyTopics: (parsed.topics as string[]) ?? [],
    factIds: projectFacts.map((f) => f.id),
  };
}
