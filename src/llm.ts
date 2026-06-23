/**
 * llm.ts — single source of truth for the OpenAI-compatible client + model config.
 *
 * Lets ira-memory run without OpenAI. Controlled by IRA_LLM_PROVIDER:
 *
 *   openai  (default) — OpenAI cloud (OPENAI_API_KEY + api.openai.com). Original behavior.
 *   gemini            — Google Gemini via its OpenAI-compatible endpoint. Reuses a Gemini API key
 *                       (GEMINI_API_KEY), Flash for summaries, Gemini embeddings. Good when you
 *                       already use Gemini for work and don't want a separate OpenAI bill.
 *   local             — any OpenAI-compatible LOCAL server (Ollama / LM Studio / llama.cpp).
 *                       Set OPENAI_BASE_URL (default http://localhost:11434/v1) + local models.
 *   none              — NO LLM at all. Zero external calls, no model server. Embeddings + summaries
 *                       are skipped; recall falls back to full-text + structured + project-tag
 *                       search (recall.ts treats the semantic layer as optional). Simplest
 *                       "completely local / nothing leaves the box" mode.
 *
 * Independent of the provider, embeddings can be turned off with IRA_EMBED=off — e.g. provider
 * `gemini` for summaries + embeddings off for FTS-only recall, which sidesteps the embedding-
 * dimension question entirely (see EMBED_DIMS below).
 *
 * EMBED_DIMS defaults to 1536 — the pgvector schema (vector(1536)). text-embedding-3-small and
 * gemini-embedding-001 can BOTH emit 1536 dims (we pass `dimensions`), so neither needs a schema
 * change. A model with a different fixed size (e.g. Ollama nomic-embed-text = 768) requires either
 * IRA_EMBED=off, or setting IRA_EMBED_DIMS=768 AND migrating the *_embeddings columns on a fresh DB.
 */
import OpenAI from "openai";

const PROVIDER = (process.env.IRA_LLM_PROVIDER || "openai").toLowerCase();

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";

export const llmProvider = PROVIDER;
// Summaries/learning need a chat model; disabled only when there's no provider.
export const summariesEnabled = PROVIDER !== "none";
// Embeddings need a provider AND not be explicitly turned off.
export const embeddingsEnabled = PROVIDER !== "none" && process.env.IRA_EMBED !== "off";
export const isFullyLocal = PROVIDER === "none" || PROVIDER === "local";

function pick(provider: string, map: Record<string, string>, fallback: string): string {
  return map[provider] ?? fallback;
}

export const EMBED_MODEL =
  process.env.IRA_EMBED_MODEL ||
  pick(PROVIDER, { local: "nomic-embed-text", gemini: "gemini-embedding-001" }, "text-embedding-3-small");

export const CHAT_MODEL =
  process.env.IRA_LLM_MODEL ||
  pick(PROVIDER, { local: "llama3.2", gemini: "gemini-2.5-flash" }, "gpt-4.1-nano");

// Stays at the schema's 1536 by default. We request this many dims explicitly when supported.
export const EMBED_DIMS = Number(process.env.IRA_EMBED_DIMS || 1536);

// OpenAI's text-embedding-3-* and Gemini's gemini-embedding-001 honor a `dimensions` request;
// fixed-size models (Ollama embed models) ignore/reject it, so only send it for those that take it.
export const EMBED_SUPPORTS_DIMENSIONS = PROVIDER === "openai" || PROVIDER === "gemini";

let _client: OpenAI | null | undefined;

/** The configured client, or null when provider is `none`. Memoized. */
export function getClient(): OpenAI | null {
  if (_client !== undefined) return _client;
  if (PROVIDER === "none") {
    _client = null;
  } else if (PROVIDER === "gemini") {
    _client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || GEMINI_OPENAI_BASE,
      apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "",
    });
  } else if (PROVIDER === "local") {
    _client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || process.env.IRA_LLM_BASE_URL || "http://localhost:11434/v1",
      apiKey: process.env.OPENAI_API_KEY || "local", // local servers ignore the key but the SDK requires one
    });
  } else {
    _client = new OpenAI(); // standard OpenAI: key + base URL from the SDK's own env handling
  }
  return _client;
}
