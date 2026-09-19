#!/bin/sh
# pre-push: block secrets from leaving this machine.
#
# Two layers, not gitleaks alone. Verified directly, against this repo's own
# history: gitleaks's default ruleset does not recognize an Anthropic
# session-key shape (sk-ant-sid01-...) at all — a real one sat in a commit
# here and `gitleaks git` returned zero findings against it. GitHub's
# server-side push protection is what actually caught it; a gitleaks-only
# local hook would have let it through. Layer 2 below is a narrow,
# low-false-positive regex net for exactly that class of gap — deliberately
# NOT the broad kv_assignment/base64 patterns from ira-memory's redact.ts,
# since a false positive here blocks a push outright rather than just adding
# a placeholder to a memory row.
#
# Fail-closed policy: if the range cannot be determined, or a scanner errors,
# or gitleaks is missing, the push is BLOCKED. An un-scanned push is treated
# as a failed scan, not a passed one.
#
# Known false positive? git push --no-verify
#
# Source of truth: ira-memory/scripts/pre-push-hook.sh (install-pre-push-hook.sh)

zero="0000000000000000000000000000000000000000"
blocked=0
scanned_any=0

scan_range() {
  range="$1"
  echo "pre-push: scanning ${range} for secrets..."

  # --- layer 1: gitleaks ---
  if command -v gitleaks >/dev/null 2>&1; then
    gl_out=$(gitleaks git --log-opts="${range}" --no-banner --log-level error --exit-code 1 2>&1)
    gl_code=$?
    if [ "$gl_code" -eq 1 ]; then
      echo "pre-push: BLOCKED — gitleaks found a likely secret:"
      echo "$gl_out"
      blocked=1
    elif [ "$gl_code" -ne 0 ]; then
      echo "pre-push: BLOCKED — gitleaks failed to run (exit ${gl_code}); treating as unscanned:"
      echo "$gl_out"
      blocked=1
    fi
  else
    echo "pre-push: BLOCKED — gitleaks not installed (brew install gitleaks)."
    echo "pre-push: an unscanned push is not a clean push. Install it, or use --no-verify."
    blocked=1
  fi

  # --- layer 2: narrow regex net for shapes gitleaks misses ---
  # shellcheck disable=SC2086
  diff_out=$(git log -p $range 2>&1)
  if [ $? -ne 0 ]; then
    echo "pre-push: BLOCKED — could not diff ${range}; treating as unscanned:"
    echo "$diff_out" | head -5
    blocked=1
    return
  fi

  hits=$(printf '%s\n' "$diff_out" | grep -E \
    -e '^\+.*\bsk-[A-Za-z0-9_-]{20,}' \
    -e '^\+.*\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}' \
    -e '^\+.*\bxox[baprs]-[A-Za-z0-9-]{10,}' \
    -e '^\+.*\bAKIA[A-Z0-9]{16}\b' \
    -e '^\+.*BEGIN[ A-Z]*PRIVATE KEY' \
    | grep -v '^+++ ')

  if [ -n "$hits" ]; then
    echo "pre-push: BLOCKED — heuristic layer found a secret-shaped string gitleaks missed:"
    printf '%s\n' "$hits" | head -20
    blocked=1
  fi

  scanned_any=1
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # branch deletion, nothing to scan

  if [ "$remote_sha" != "$zero" ] && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    # Normal case: remote tip is known locally, scan what's new since it.
    range="${remote_sha}..${local_sha}"
  else
    # New ref, or a remote tip this clone has never fetched. Scan everything
    # reachable from local_sha that isn't already on some remote-tracking ref.
    # With no remote refs at all this degrades to full history — intentional,
    # that is the fail-closed direction.
    range="${local_sha} --not --remotes"
    if [ -z "$(git rev-list --max-count=1 $range 2>/dev/null)" ]; then
      echo "pre-push: nothing new to scan for ${local_ref}."
      continue
    fi
  fi

  scan_range "$range"
done

if [ "$blocked" -eq 1 ]; then
  echo
  echo "pre-push: push blocked. Fix and re-commit, or if this is a genuine false positive:"
  echo "  git push --no-verify"
  exit 1
fi

exit 0
