import type {
  MemoryCategory,
  MemoryTier,
  SummaryScope,
  LearningType,
  Session,
  Message,
  MemoryFact,
  Summary,
} from "@prisma/client";

export type { MemoryCategory, MemoryTier, SummaryScope, LearningType, Session, Message, MemoryFact, Summary };

// ─── Store inputs ───────────────────────────────────────────────

export interface OpenSessionInput {
  channel: string;
  agentId?: string;
  hostId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface StoreMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** Skip the automatic async embed for this row (plan Phase 4: tool results are never embedded). Default false. */
  skipEmbed?: boolean;
  tokenCount?: number;
  model?: string;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface StoreFactInput {
  category: MemoryCategory;
  content: string;
  tier?: MemoryTier;
  source?: string;
  sourceRef?: string;
  confidence?: number;
  tags?: string[];
  isSensitive?: boolean;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  learningType?: LearningType;
  provenance?: string;
}

// ─── Recall inputs ──────────────────────────────────────────────

export interface RecallInput {
  query?: string;
  categories?: MemoryCategory[];
  tier?: MemoryTier;
  /** Hard filter: results MUST carry one of these tags ("tag-scoped or nothing"). */
  tags?: string[];
  /** Soft boost: results carrying one of these tags rank higher, but others still surface
   *  (so a sparse/new project never returns an empty recall). Use for cwd-derived scoping. */
  boostTags?: string[];
  timeRange?: { after?: Date; before?: Date };
  channel?: string;
  sessionId?: string;
  limit?: number;
  includeMessages?: boolean;
}

export interface RecallResult {
  facts: Array<MemoryFact & { score: number }>;
  summaries: Array<Summary & { score: number }>;
  messages?: Array<Message & { score: number }>;
}

export interface TextSearchInput {
  query: string;
  tables?: Array<"facts" | "messages">;
  limit?: number;
}

export interface TextSearchResult {
  facts: Array<MemoryFact & { rank: number }>;
  messages: Array<Message & { rank: number }>;
}

export interface ListFactsInput {
  category?: MemoryCategory;
  tier?: MemoryTier;
  tags?: string[];
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

// ─── Semantic search ────────────────────────────────────────────

export interface SemanticSearchInput {
  query: string;
  tables?: Array<"facts" | "summaries" | "messages">;
  limit?: number;
  threshold?: number;
  channel?: string;
}

export interface SemanticSearchResult {
  facts: Array<MemoryFact & { similarity: number }>;
  summaries: Array<Summary & { similarity: number }>;
  messages: Array<Message & { similarity: number }>;
}

// ─── Summarize ──────────────────────────────────────────────────

export interface SummarizeInput {
  scope: SummaryScope;
  sessionId?: string;
  periodStart?: Date;
  periodEnd?: Date;
  projectName?: string;
}

// ─── Maintenance ────────────────────────────────────────────────

export interface MaintenanceResult {
  promoted: { shortToDaily: number; dailyToLong: number };
  expired: number;
}

export interface ConflictPair {
  factA: MemoryFact;
  factB: MemoryFact;
  reason: string;
}

// ─── Export ─────────────────────────────────────────────────────

export interface MemoryExport {
  exportedAt: string;
  stats: {
    sessions: number;
    messages: number;
    facts: number;
    summaries: number;
  };
  sessions: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  summaries: Array<Record<string, unknown>>;
}

// ─── Import ─────────────────────────────────────────────────────

export interface ImportInput {
  memoryMdPath: string;
  dailyDir: string;
  force?: boolean;
}

export interface ImportResult {
  filesProcessed: number;
  factsCreated: number;
  factsSkipped: number;
  errors: string[];
}

// ─── Learn ─────────────────────────────────────────────────────

export interface LearnInput {
  sessionId: string;
  types?: LearningType[];
  context?: string;
  minConfidence?: number;
  dedup?: boolean;
}

export interface LearnResult {
  sessionId: string;
  learnings: Array<{
    fact: MemoryFact;
    learningType: LearningType;
    confidence: number;
    reasoning: string;
  }>;
  skipped: number;
  totalExtracted: number;
}

// ─── Discover ──────────────────────────────────────────────────

export type DiscoverAspect =
  | "architecture"
  | "naming"
  | "api"
  | "data_models"
  | "testing"
  | "dependencies";

export interface DiscoverInput {
  directory: string;
  include?: string[];
  exclude?: string[];
  aspects?: DiscoverAspect[];
  projectName?: string;
  maxFiles?: number;
  force?: boolean;
}

export interface DiscoverResult {
  directory: string;
  filesScanned: number;
  discoveries: Array<{
    fact: MemoryFact;
    aspect: DiscoverAspect;
    confidence: number;
    evidence: string[];
  }>;
  totalDiscovered: number;
}

// ─── Synthesize ────────────────────────────────────────────────

export interface SynthesizeInput {
  question: string;
  categories?: MemoryCategory[];
  learningTypes?: LearningType[];
  includeMessages?: boolean;
  save?: boolean;
  tags?: string[];
}

export interface SynthesizeResult {
  question: string;
  synthesis: string;
  sourceFacts: Array<{ id: string; content: string; score: number }>;
  sourceSummaries: Array<{ id: string; content: string; score: number }>;
  savedFact?: MemoryFact;
  confidence: number;
}

// ─── Recall messages (Phase 5: pi-ira-memory-capture.md) ────────────

export interface RecallMessagesInput {
  query: string;
  /** Session metadata.project value (pi sessions only carry this). */
  project?: string;
  channel?: string;
  limit?: number;
}

export interface RecallMessagesResult {
  messages: Array<Message & { score: number; channel: string | null }>;
}

// ─── Decisions extraction (Phase 6: pi-ira-memory-capture.md) ────────

export interface ExtractDecisionsInput {
  sessionId: string;
  /** Raw project slug (no "project:" prefix), used for the fact's project tag. */
  project?: string;
  minConfidence?: number;
  dedup?: boolean;
}

export interface ExtractedDecision {
  fact: MemoryFact;
  confidence: number;
  reasoning: string;
}

export interface ExtractDecisionsResult {
  sessionId: string;
  decisions: ExtractedDecision[];
  skipped: number;
  totalExtracted: number;
}
