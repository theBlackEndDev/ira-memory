import OpenAI from "openai";
import { recall } from "./recall.js";
import { store } from "./store.js";
import type { SynthesizeInput, SynthesizeResult, LearningType } from "./types.js";

const openai = new OpenAI();

const SYSTEM_PROMPT = `You are a knowledge synthesis engine. Given a question and relevant knowledge from a memory database, produce a comprehensive answer.

Rules:
- Synthesize all available information into a coherent, actionable answer
- Note any contradictions or gaps in the available knowledge
- Rate your confidence (0.0-1.0) based on the quality and coverage of source material
- If the sources are sparse or tangential, say so honestly and lower confidence
- Be specific and practical — the answer should be directly useful

Respond in this exact JSON format:
{"synthesis": "...", "confidence": 0.85}`;

/**
 * Query existing knowledge and synthesize a comprehensive answer.
 * Optionally saves the synthesis as a new compounded fact.
 */
export async function synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
  // Recall relevant knowledge using the existing multi-layer system
  const recalled = await recall({
    query: input.question,
    categories: input.categories,
    limit: 30,
    includeMessages: input.includeMessages,
  });

  // Filter by learning types if specified
  let facts = recalled.facts;
  if (input.learningTypes && input.learningTypes.length > 0) {
    const typeSet = new Set<string>(input.learningTypes);
    facts = facts.filter((f) => {
      const lt = (f as any).learningType as LearningType | null;
      return lt && typeSet.has(lt);
    });
  }

  // Build context for LLM
  const contextParts: string[] = [];

  if (facts.length > 0) {
    contextParts.push("[Relevant Facts]");
    for (const f of facts) {
      const lt = (f as any).learningType;
      const typeLabel = lt ? `/${lt}` : "";
      contextParts.push(`- [${f.category}${typeLabel}] (confidence: ${f.confidence}, score: ${f.score.toFixed(2)}) ${f.content}`);
    }
  }

  if (recalled.summaries.length > 0) {
    contextParts.push("\n[Relevant Summaries]");
    for (const s of recalled.summaries) {
      contextParts.push(`- [${s.scope}] ${s.content.slice(0, 500)}`);
    }
  }

  if (recalled.messages && recalled.messages.length > 0) {
    contextParts.push("\n[Relevant Messages]");
    for (const m of recalled.messages.slice(0, 10)) {
      contextParts.push(`- [${m.role}] ${m.content.slice(0, 300)}`);
    }
  }

  const context = contextParts.join("\n");

  // Call LLM for synthesis
  const llmResponse = await openai.chat.completions.create({
    model: "gpt-4.1-nano",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: context
          ? `Question: ${input.question}\n\nAvailable Knowledge:\n${context}`
          : `Question: ${input.question}\n\nNo relevant knowledge found in the database. Provide a low-confidence answer based on general knowledge, or state that there's insufficient data.`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");

  const result: SynthesizeResult = {
    question: input.question,
    synthesis: parsed.synthesis ?? "Failed to generate synthesis.",
    sourceFacts: facts.map((f) => ({ id: f.id, content: f.content, score: f.score })),
    sourceSummaries: recalled.summaries.map((s) => ({ id: s.id, content: s.content, score: s.score })),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.3,
  };

  // Optionally save the synthesis as a new compounded fact
  if (input.save) {
    const savedFact = await store({
      category: "FACT",
      content: result.synthesis,
      tier: "DAILY",
      source: "inferred",
      confidence: result.confidence,
      tags: ["synthesized", ...(input.tags ?? [])],
      provenance: "synthesized",
      metadata: {
        question: input.question,
        sourceFactIds: result.sourceFacts.map((f) => f.id),
        sourceSummaryIds: result.sourceSummaries.map((s) => s.id),
      },
    });
    result.savedFact = savedFact;
  }

  return result;
}
