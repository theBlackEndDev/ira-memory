#!/bin/sh
# Exercises scripts/pre-push-hook.sh against throwaway repos.
# Cases: new branch w/ secret, new branch clean, main->main update w/ secret,
# main->main update clean, branch deletion, unknown remote sha (fail closed).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
hook="${here}/pre-push-hook.sh"
zero="0000000000000000000000000000000000000000"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# A real-shaped Anthropic session key, assembled at runtime so this file
# itself never contains a matchable literal.
secret="sk-ant-sid01-$(printf 'A%.0s' $(seq 1 86))AA"

check() { # name expected_exit actual_exit output
  if [ "$2" -eq "$3" ]; then
    printf '  PASS  %s (exit %s)\n' "$1" "$3"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s — expected exit %s, got %s\n' "$1" "$2" "$3"
    printf '%s\n' "$4" | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}

run_hook() { # repo  <-- stdin is the ref line
  (cd "$1" && sh "$hook") 2>&1
}

mkrepo() { # name
  r="${tmp}/$1"
  mkdir -p "$r"
  git -C "$r" init -q
  git -C "$r" config user.email t@t.t
  git -C "$r" config user.name t
  git -C "$r" config commit.gpgsign false
  echo "$r"
}

commit() { # repo file content msg
  printf '%s\n' "$3" >"${1}/${2}"
  git -C "$1" add -A
  git -C "$1" commit -qm "$4"
  git -C "$1" rev-parse HEAD
}

echo "pre-push hook tests"

# --- 1. new branch, no remote refs at all, secret in root commit -------------
r=$(mkrepo newbranch-secret)
sha=$(commit "$r" leak.txt "ANTHROPIC_API_KEY=$secret" "oops")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$zero" | run_hook "$r") && code=0 || code=$?
check "new branch + secret in root commit -> blocked" 1 "$code" "$out"

# --- 2. new branch, no remote refs, clean -----------------------------------
r=$(mkrepo newbranch-clean)
sha=$(commit "$r" ok.txt "nothing to see" "init")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$zero" | run_hook "$r") && code=0 || code=$?
check "new branch + clean root commit -> allowed" 0 "$code" "$out"

# --- 3. main -> main update with a secret (the common real case) ------------
r=$(mkrepo update-secret)
base=$(commit "$r" ok.txt "fine" "init")
git -C "$r" update-ref refs/remotes/origin/main "$base"
head=$(commit "$r" leak.txt "key: $secret" "add key")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | run_hook "$r") && code=0 || code=$?
check "main->main update + secret -> blocked" 1 "$code" "$out"

# --- 4. main -> main update, clean ------------------------------------------
r=$(mkrepo update-clean)
base=$(commit "$r" ok.txt "fine" "init")
git -C "$r" update-ref refs/remotes/origin/main "$base"
head=$(commit "$r" more.txt "also fine" "more")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | run_hook "$r") && code=0 || code=$?
check "main->main update + clean -> allowed" 0 "$code" "$out"

# --- 5. old secret already on the remote is not re-flagged ------------------
r=$(mkrepo already-pushed)
base=$(commit "$r" leak.txt "key: $secret" "leaked long ago")
git -C "$r" update-ref refs/remotes/origin/main "$base"
head=$(commit "$r" ok.txt "clean now" "clean commit")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | run_hook "$r") && code=0 || code=$?
check "secret already on remote, new clean commit -> allowed" 0 "$code" "$out"

# --- 6. branch deletion is a no-op ------------------------------------------
r=$(mkrepo deletion)
base=$(commit "$r" ok.txt "fine" "init")
out=$(printf 'refs/heads/gone %s refs/heads/gone %s\n' "$zero" "$base" | run_hook "$r") && code=0 || code=$?
check "branch deletion -> allowed, no scan" 0 "$code" "$out"

# --- 7. remote sha unknown locally -> must NOT silently pass ----------------
r=$(mkrepo unknown-remote)
sha=$(commit "$r" leak.txt "key: $secret" "oops")
out=$(printf 'refs/heads/main %s refs/heads/main deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' "$sha" | run_hook "$r") && code=0 || code=$?
check "unknown remote sha + secret -> blocked (fail closed)" 1 "$code" "$out"

# --- 8. gitleaks missing -> fail closed -------------------------------------
r=$(mkrepo no-gitleaks)
sha=$(commit "$r" ok.txt "fine" "init")
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$zero" \
  | (cd "$r" && PATH=/usr/bin:/bin sh "$hook")) 2>&1 && code=0 || code=$?
check "gitleaks not on PATH -> blocked" 1 "$code" "$out"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
