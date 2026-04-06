// IRA Memory System - Public API

// Store operations
export {
  openSession,
  closeSession,
  storeMessage,
  store,
  forget,
  hardDelete,
  updateFact,
  promote,
} from "./store.js";

// Recall & search
export { recall, textSearch, listFacts } from "./recall.js";
export { semanticSearch } from "./search.js";

// Embeddings
export {
  embedMessage,
  embedFact,
  embedSummary,
  embedMessageAsync,
  embedFactAsync,
  embedSummaryAsync,
  backfillFactEmbeddings,
  backfillMessageEmbeddings,
  generateEmbedding,
} from "./embed.js";

// Summarization
export { summarize } from "./summarize.js";

// Learning layer
export { learn } from "./learn.js";
export { discover } from "./discover.js";
export { synthesize } from "./synthesize.js";

// Maintenance
export { promoteAndExpire, detectConflicts, compactMessages } from "./maintain.js";

// Export & backup
export {
  exportAll,
  exportMarkdown,
  backup,
  restore,
  isSensitiveContent,
  detectSensitiveFacts,
} from "./export.js";

// Import
export { importFromFiles } from "./import.js";

// Client
export { prisma } from "./client.js";

// Types
export type {
  OpenSessionInput,
  StoreMessageInput,
  StoreFactInput,
  RecallInput,
  RecallResult,
  TextSearchInput,
  TextSearchResult,
  ListFactsInput,
  SemanticSearchInput,
  SemanticSearchResult,
  SummarizeInput,
  MaintenanceResult,
  ConflictPair,
  MemoryExport,
  ImportInput,
  ImportResult,
  LearnInput,
  LearnResult,
  DiscoverInput,
  DiscoverResult,
  DiscoverAspect,
  SynthesizeInput,
  SynthesizeResult,
  MemoryCategory,
  MemoryTier,
  SummaryScope,
  LearningType,
  Session,
  Message,
  MemoryFact,
  Summary,
} from "./types.js";
