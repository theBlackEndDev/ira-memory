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

# Resolve the project root from the script's own location so this file
# has no machine-specific paths baked in.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/maintain.log"

# Find bun on PATH; fall back to the common install location. Cron jobs
# typically run with a minimal PATH so we extend it explicitly.
export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
BUN="$(command -v bun || true)"
if [[ -z "${BUN}" && -x "${HOME}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
fi
if [[ -z "${BUN}" ]]; then
  echo "cron-maintain: bun not found on PATH or in ~/.bun/bin" >&2
  exit 1
fi

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
