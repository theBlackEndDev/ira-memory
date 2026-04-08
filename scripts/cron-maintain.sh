#!/usr/bin/env bash
# cron-maintain.sh — Runs ira-memory's `maintain` pass.
#
# Does:
#   1. Tier promotion (SHORT_TERM -> DAILY -> LONG_TERM) and expiration
#   2. Backfills summaries + learnings for any closed sessions that
#      cc-capture skipped in its hot path
#   3. Backfills embeddings for any facts/messages that slipped through
#      the fire-and-forget write path
#
# Invoked by cron. See crontab entry.

set -u

PROJECT_DIR="/home/hus/golden-claw-workspace/orchestrator/projects/ira-memory"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/maintain.log"
BUN="/home/hus/.bun/bin/bun"

mkdir -p "${LOG_DIR}"

# Load env so OPENAI_API_KEY + MEMORY_DATABASE_URL are available
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

{
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "$(date -Iseconds) — maintain start"
  echo "═══════════════════════════════════════════════════════════════"
  cd "${PROJECT_DIR}" && "${BUN}" run src/cli.ts maintain
  echo "$(date -Iseconds) — maintain end (exit=$?)"
} >> "${LOG_FILE}" 2>&1
