-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "MemoryCategory" AS ENUM ('PREFERENCE', 'DECISION', 'PLAN', 'TODO', 'FACT', 'LESSON', 'CHECKPOINT', 'CONTEXT', 'TOOL_CONFIG', 'PROJECT_STATE');

-- CreateEnum
CREATE TYPE "MemoryTier" AS ENUM ('SHORT_TERM', 'DAILY', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "SummaryScope" AS ENUM ('SESSION', 'DAILY', 'WEEKLY', 'PROJECT');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "agent_id" TEXT,
    "host_id" TEXT,
    "title" TEXT,
    "metadata" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_name" TEXT,
    "tool_input" JSONB,
    "tool_output" JSONB,
    "token_count" INTEGER,
    "model" TEXT,
    "cost_usd" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_facts" (
    "id" TEXT NOT NULL,
    "category" "MemoryCategory" NOT NULL,
    "tier" "MemoryTier" NOT NULL DEFAULT 'SHORT_TERM',
    "content" TEXT NOT NULL,
    "source" TEXT,
    "source_ref" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "tags" TEXT[],
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "superseded_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "summaries" (
    "id" TEXT NOT NULL,
    "scope" "SummaryScope" NOT NULL,
    "session_id" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "key_topics" TEXT[],
    "fact_ids" TEXT[],
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_embeddings" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "vector" vector(1536) NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_embeddings" (
    "id" TEXT NOT NULL,
    "fact_id" TEXT NOT NULL,
    "vector" vector(1536) NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "summary_embeddings" (
    "id" TEXT NOT NULL,
    "summary_id" TEXT NOT NULL,
    "vector" vector(1536) NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "summary_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_sync_records" (
    "id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fact_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "file_sync_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_channel_idx" ON "sessions"("channel");

-- CreateIndex
CREATE INDEX "sessions_started_at_idx" ON "sessions"("started_at" DESC);

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_idx" ON "messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at" DESC);

-- CreateIndex
CREATE INDEX "memory_facts_category_idx" ON "memory_facts"("category");

-- CreateIndex
CREATE INDEX "memory_facts_tier_idx" ON "memory_facts"("tier");

-- CreateIndex
CREATE INDEX "memory_facts_is_archived_idx" ON "memory_facts"("is_archived");

-- CreateIndex
CREATE INDEX "memory_facts_tags_idx" ON "memory_facts" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "memory_facts_created_at_idx" ON "memory_facts"("created_at" DESC);

-- CreateIndex
CREATE INDEX "summaries_scope_idx" ON "summaries"("scope");

-- CreateIndex
CREATE INDEX "summaries_period_start_idx" ON "summaries"("period_start" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "message_embeddings_message_id_key" ON "message_embeddings"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "fact_embeddings_fact_id_key" ON "fact_embeddings"("fact_id");

-- CreateIndex
CREATE UNIQUE INDEX "summary_embeddings_summary_id_key" ON "summary_embeddings"("summary_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_sync_records_file_path_key" ON "file_sync_records"("file_path");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_embeddings" ADD CONSTRAINT "fact_embeddings_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "memory_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "summary_embeddings" ADD CONSTRAINT "summary_embeddings_summary_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
