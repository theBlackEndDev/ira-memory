// Decisions extraction — Phase 6 of pi-ira-memory-capture.md, and the
// direct fix for the incident that started this whole project: an audit
// agent flagged nine already-settled architecture decisions as "unresolved"
// because nothing distinguished a LOCKED choice from an open question in
// memory. Deliberately separate from learn.ts's MISTAKE/BEST_PRACTICE/etc
// taxonomy — those are lessons about HOW to work; a decision is WHAT was
// chosen and WHY, and it needs to survive being re-litigated, not just be
// remembered as a preference.

import { prisma } from "./client.js";
import { store } from "./store.js";
import { semanticSearch } from "./search.js";
import { getClient, CHAT_MODEL } from "./llm.js";
import type { ExtractDecisionsInput, ExtractDecisionsResult } from "./types.js";

const openai = getClient(); // null when IRA_LLM_PROVIDER=none — extraction is skipped, not faked

// The prompt is the whole mechanism here — this is the part that has to
// actually solve the incident, not just the schema. The failure mode was an
// agent treating settled canon as open; the prompt has to make LOCKED status
// unambiguous and force the model to distinguish "we decided X" from "we
// discussed X" from "X is still open."
const SYSTEM_PROMPT = `You analyze a conversation to extract LOCKED DECISIONS — things that were actually decided, chosen, or settled, not things that were merely discussed or left open.

A decision is a candidate for extraction when the conversation shows one of these signals:
- Explicit lock language: "locked", "decided", "final", "let's go with X", "X it is", "confirmed", "settled on X"
- The user picks one option after being presented with several
- A question is asked and definitively answered, and the answer is treated as established fact for the rest of the conversation
- An architectural, design, or world-building choice is stated and never contradicted afterward

Do NOT extract:
- Open questions, unresolved debates, or things explicitly flagged as "TODO" / "still deciding" / "need to think about this"
- Hypotheticals or options that were considered and REJECTED (unless the rejection itself is the useful decision — e.g. "we will NOT do X because Y")
- Vague preferences with no concrete resolution

For each decision, extract:
- "decision": one sentence stating WHAT was decided, phrased as settled fact (e.g. "The Crossroads is Faustian deal-making / pact magic, not a physical location.") — NOT "we discussed whether..."
- "rationale": WHY, in enough detail that someone reading only this sentence understands the reasoning without the original conversation
- "status": always "LOCKED" for anything extracted (if it's not locked, don't extract it)
- "confidence": 0.0-1.0, how clearly and unambiguously this was settled (a one-line aside gets lower confidence than an explicit "locked, moving on")
- "reasoning": brief note on which signal above triggered extraction

Each decision must be self-contained and understandable without the original conversation. Skip decisions that are too implementation-trivial to matter next session (e.g. "used a for loop instead of map").

If no decisions were locked in this conversation, return an empty array — that is a normal, expected result, not a failure.

Respond in this exact JSON format:
{"decisions": [{"decision": "...", "rationale": "...", "status": "LOCKED", "confidence": 0.9, "reasoning": "..."}]}`;

/**
 * Analyze a session's messages and extract structured, LOCKED decisions.
 * Stores each as a MemoryFact: category DECISION, tier LONG_TERM (a locked
 * decision should not decay through the SHORT_TERM 48h promotion path the
 * way a passing preference does), tags ["decision", "project:<slug>"].
 */
export async function extractDecisions(input: ExtractDecisionsInput): Promise<ExtractDecisionsResult> {
  const minConfidence = input.minConfidence ?? 0.6;

  const messages = await prisma.message.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { createdAt: "asc" },
  });

  if (messages.length === 0) {
    return { sessionId: input.sessionId, decisions: [], skipped: 0, totalExtracted: 0 };
  }

  // A larger budget than summarize.ts/learn.ts's 12000-char convention on
  // purpose: decisions are exactly the kind of thing that shows up late in a
  // long working session (after the exploration, once something is finally
  // locked), and this extraction runs once at session close, not on every
  // turn — low frequency, high value, worth the extra tokens. Still capped;
  // an unbounded session is still a real cost/latency concern.
  const MAX_DECISION_CONVO_CHARS = Number(process.env.IRA_DECISIONS_CONVO_CAP ?? 60_000);
  let convoText = "";
  for (const msg of messages) {
    const line = `[${msg.role}]: ${msg.content}\n`;
    if (convoText.length + line.length > MAX_DECISION_CONVO_CHARS) {
      convoText += "\n[...truncated...]\n";
      break;
    }
    convoText += line;
  }

  if (!openai) return { sessionId: input.sessionId, decisions: [], skipped: 0, totalExtracted: 0 };

  const llmResponse = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Extract locked decisions from this conversation:\n\n${convoText}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2, // lower than learn.ts's 0.3 — decisions need consistent, literal extraction, not creative paraphrase
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");
  if (!parsed.decisions || !Array.isArray(parsed.decisions)) {
    return { sessionId: input.sessionId, decisions: [], skipped: 0, totalExtracted: 0 };
  }

  const result: ExtractDecisionsResult = { sessionId: input.sessionId, decisions: [], skipped: 0, totalExtracted: 0 };
  const projectTag = input.project ? `project:${input.project}` : undefined;

  for (const raw of parsed.decisions) {
    if (typeof raw.decision !== "string" || !raw.decision.trim()) continue;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
    if (confidence < minConfidence) continue;

    const content = raw.rationale ? `${raw.decision} — ${raw.rationale}` : raw.decision;

    // Dedup against existing decisions, not the whole fact corpus — a
    // decision restated in a later session (reconfirming, not contradicting)
    // shouldn't spam a duplicate row every time it's mentioned again.
    if (input.dedup) {
      try {
        const similar = await semanticSearch({ query: content, tables: ["facts"], limit: 3, threshold: 0.85 });
        const similarDecisions = similar.facts.filter((f) => f.category === "DECISION");
        if (similarDecisions.length > 0) {
          result.skipped++;
          continue;
        }
      } catch {
        // Semantic search failure is non-fatal — proceed without dedup.
      }
    }

    const fact = await store({
      category: "DECISION",
      content,
      tier: "LONG_TERM",
      source: "inferred",
      sourceRef: input.sessionId,
      confidence,
      tags: ["decision", ...(projectTag ? [projectTag] : [])],
      provenance: "learned",
      metadata: { reasoning: raw.reasoning, status: raw.status ?? "LOCKED" },
    });

    result.decisions.push({ fact, confidence, reasoning: raw.reasoning ?? "" });
  }

  result.totalExtracted = result.decisions.length;
  return result;
}
