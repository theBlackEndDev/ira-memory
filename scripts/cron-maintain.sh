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
# has no machine-specific paths baked in. Override with IRA_PROJECT_DIR.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${IRA_PROJECT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
LOG_DIR="${IRA_LOG_DIR:-${PROJECT_DIR}/logs}"
LOG_FILE="${LOG_DIR}/maintain.log"

mkdir -p "${LOG_DIR}"

# Load env file BEFORE resolving bun so IRA_BUN_PATH from .env takes effect.
# Cron runs with a minimal environment; .env is how operators configure this.
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

# Resolve bun. Order of precedence:
#   1. IRA_BUN_PATH (explicit override — set this in .env for non-default installs,
#      e.g. bun via nvm, asdf, pnpm, nix, custom prefix)
#   2. `command -v bun` on the (extended) PATH
#   3. ~/.bun/bin/bun (default installer location)
export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
BUN="${IRA_BUN_PATH:-}"
if [[ -z "${BUN}" ]]; then
  BUN="$(command -v bun || true)"
fi
if [[ -z "${BUN}" && -x "${HOME}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
fi
if [[ -z "${BUN}" || ! -x "${BUN}" ]]; then
  echo "cron-maintain: bun not found. Set IRA_BUN_PATH in ${PROJECT_DIR}/.env" >&2
  exit 1
fi

{
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "$(date -Iseconds) — maintain start"
  echo "═══════════════════════════════════════════════════════════════"
  cd "${PROJECT_DIR}" && "${BUN}" run src/cli.ts maintain
  echo "$(date -Iseconds) — maintain end (exit=$?)"
} >> "${LOG_FILE}" 2>&1
