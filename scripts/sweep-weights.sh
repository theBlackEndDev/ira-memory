#!/bin/bash
# Sweeps recall ranking weights against the labelled eval corpus.
#
# Spins a throwaway API instance on port 7776 per weight vector, runs eval-recall.ts against it,
# then kills it. The live service on 7775 is never touched. Note the instance shares the same
# Postgres, so the eval's `__eval_*` rows land in the real store — eval-recall.ts deletes them in
# a finally block, and this script asserts zero survivors at the end.
set -u
cd "$(dirname "$0")/.." || exit 1

PORT=7776
BASE="http://127.0.0.1:$PORT"

run_one() {
  local name="$1" rec="$2" rel="$3" tier="$4" conf="$5"
  MEMORY_API_PORT=$PORT \
  IRA_W_RECENCY="$rec" IRA_W_RELEVANCE="$rel" IRA_W_TIER="$tier" IRA_W_CONFIDENCE="$conf" \
    bun run src/http-server.ts >/tmp/ira-eval.log 2>&1 &
  local pid=$!
  for _ in $(seq 1 25); do
    curl -s -m 1 "$BASE/health" >/dev/null 2>&1 && break
    sleep 0.4
  done
  if ! curl -s -m 2 "$BASE/health" >/dev/null 2>&1; then
    echo "  $name: FAILED TO START (see /tmp/ira-eval.log)"; kill $pid 2>/dev/null; return
  fi
  printf '  %-20s ' "$name"
  bun run scripts/eval-recall.ts --base "$BASE" 2>/dev/null | grep -E '^P@1' | sed 's/^/ /'
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  sleep 0.5
}

echo "weight sweep (recency / relevance / tier / confidence)"
echo "─────────────────────────────────────────────────────"
run_one "committed-pre-fix"  0.3  0.4  0.2  0.1
run_one "relevance-lean"     0.2  0.55 0.15 0.1
run_one "relevance-strong"   0.15 0.6  0.15 0.1
run_one "relevance-dominant" 0.05 0.8  0.1  0.05
run_one "relevance-only"     0.0  1.0  0.0  0.0

echo
echo "─── residue check: any __eval_ rows left in the live store? ───"
curl -s -m 8 "http://127.0.0.1:7775/memory/recall?topic=x&limit=100" \
  | python3 -c "
import json,sys
f=json.load(sys.stdin).get('facts',[])
left=[x for x in f if str(x.get('name','')).startswith('__eval_')]
print(f'  total facts: {len(f)}   eval residue: {len(left)}  <-- must be 0')
for x in left[:5]: print('   LEFTOVER:',x.get('name'))
"
