-- CreateEnum
CREATE TYPE "LearningType" AS ENUM ('MISTAKE', 'BEST_PRACTICE', 'INSTITUTIONAL', 'WORKFLOW_PREF', 'CODEBASE_RULE');

-- DropIndex
DROP INDEX "idx_fact_embeddings_vector";

-- DropIndex
DROP INDEX "idx_memory_facts_content_trgm";

-- DropIndex
DROP INDEX "idx_memory_facts_content_tsv";

-- DropIndex
DROP INDEX "idx_message_embeddings_vector";

-- DropIndex
DROP INDEX "idx_messages_content_tsv";

-- DropIndex
DROP INDEX "idx_summary_embeddings_vector";

-- AlterTable
ALTER TABLE "memory_facts" DROP COLUMN "content_tsv",
ADD COLUMN     "learning_type" "LearningType",
ADD COLUMN     "provenance" TEXT;

-- AlterTable
ALTER TABLE "messages" DROP COLUMN "content_tsv";

-- CreateIndex
CREATE INDEX "memory_facts_learning_type_idx" ON "memory_facts"("learning_type");

