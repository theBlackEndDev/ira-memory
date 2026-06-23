import { prisma } from "./client.js";
import { store } from "./store.js";
import { semanticSearch } from "./search.js";
import { getClient, CHAT_MODEL } from "./llm.js";
import type { LearnInput, LearnResult, LearningType, MemoryCategory } from "./types.js";

const openai = getClient(); // null when IRA_LLM_PROVIDER=none → learning extraction is skipped

const VALID_LEARNING_TYPES = new Set<string>([
  "MISTAKE", "BEST_PRACTICE", "INSTITUTIONAL", "WORKFLOW_PREF", "CODEBASE_RULE",
]);

/** Map learning types to the best-fit existing MemoryCategory */
const LEARNING_TO_CATEGORY: Record<string, MemoryCategory> = {
  MISTAKE: "LESSON",
  BEST_PRACTICE: "LESSON",
  INSTITUTIONAL: "CONTEXT",
  WORKFLOW_PREF: "PREFERENCE",
  CODEBASE_RULE: "FACT",
};

const SYSTEM_PROMPT = `You analyze conversations to extract actionable learnings. Given a conversation, identify learnings in these categories:

1. MISTAKE - Things that went wrong, bugs caused, failed approaches, anti-patterns discovered
2. BEST_PRACTICE - Patterns that worked well, efficient approaches, successful strategies
3. INSTITUTIONAL - How this codebase/team/project works, unwritten rules, tribal knowledge
4. WORKFLOW_PREF - User preferences for tools, editor settings, workflow configurations
5. CODEBASE_RULE - Naming conventions, architecture patterns, testing requirements, code style rules

Rules:
- Only extract learnings that are ACTIONABLE and REUSABLE in future sessions
- Each learning must be self-contained (understandable without the conversation context)
- Rate confidence 0.0-1.0 based on how clearly the learning was demonstrated
- Provide brief reasoning for why you extracted each learning
- Skip trivial or overly specific learnings (e.g., "fixed a typo" is not a learning)
- Prefer general principles over one-off observations
- Do NOT extract credentials, secrets, API keys, or sensitive URLs
- If no learnings are found, return an empty array

Respond in this exact JSON format:
{"learnings": [{"type": "MISTAKE|BEST_PRACTICE|INSTITUTIONAL|WORKFLOW_PREF|CODEBASE_RULE", "content": "...", "confidence": 0.85, "reasoning": "..."}]}`;

/**
 * Analyze a session's messages and extract structured learnings.
 * Uses LLM to identify mistakes, best practices, institutional knowledge,
 * workflow preferences, and codebase rules from the conversation.
 */
export async function learn(input: LearnInput): Promise<LearnResult> {
  const minConfidence = input.minConfidence ?? 0.6;

  // Fetch session messages
  const messages = await prisma.message.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { createdAt: "asc" },
  });

  if (messages.length === 0) {
    return { sessionId: input.sessionId, learnings: [], skipped: 0, totalExtracted: 0 };
  }

  // Build conversation text (truncate to ~12000 chars, same as summarize.ts)
  let convoText = "";
  for (const msg of messages) {
    const line = `[${msg.role}]: ${msg.content}\n`;
    if (convoText.length + line.length > 12000) {
      convoText += "\n[...truncated...]\n";
      break;
    }
    convoText += line;
  }

  // Build user prompt
  let userPrompt = `Extract learnings from this conversation:\n\n${convoText}`;
  if (input.context) {
    userPrompt += `\n\nAdditional context: ${input.context}`;
  }

  // Call LLM (skipped when no provider — learning extraction needs an LLM)
  if (!openai) return { sessionId: input.sessionId, learnings: [], skipped: 0, totalExtracted: 0 };
  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  if (!parsed.learnings || !Array.isArray(parsed.learnings)) {
    return { sessionId: input.sessionId, learnings: [], skipped: 0, totalExtracted: 0 };
  }

  const result: LearnResult = {
    sessionId: input.sessionId,
    learnings: [],
    skipped: 0,
    totalExtracted: 0,
  };

  for (const raw of parsed.learnings) {
    // Validate learning type
    if (!VALID_LEARNING_TYPES.has(raw.type)) continue;

    // Filter by requested types
    if (input.types && !input.types.includes(raw.type as LearningType)) continue;

    // Apply confidence threshold
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
    if (confidence < minConfidence) continue;

    // Dedup: check semantic similarity against existing learnings
    if (input.dedup) {
      try {
        const similar = await semanticSearch({
          query: raw.content,
          tables: ["facts"],
          limit: 3,
          threshold: 0.85,
        });
        if (similar.facts.length > 0) {
          result.skipped++;
          continue;
        }
      } catch {
        // Semantic search failure is non-fatal — proceed without dedup
      }
    }

    // Store the learning as a fact
    const learningType = raw.type as LearningType;
    const category = LEARNING_TO_CATEGORY[learningType] ?? "FACT";

    const fact = await store({
      category: category as MemoryCategory,
      content: raw.content,
      tier: "SHORT_TERM",
      source: "inferred",
      sourceRef: input.sessionId,
      confidence,
      tags: ["learning", learningType.toLowerCase()],
      learningType,
      provenance: "learned",
      metadata: { reasoning: raw.reasoning },
    });

    result.learnings.push({
      fact,
      learningType,
      confidence,
      reasoning: raw.reasoning ?? "",
    });
  }

  result.totalExtracted = result.learnings.length;
  return result;
}
