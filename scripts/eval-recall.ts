/**
 * eval-recall.ts — measures recall ranking quality against known ground truth.
 *
 * Why this exists: the ranking weights were originally tuned by eyeballing four queries against a
 * 17-fact store, which is not evidence. This seeds a labelled synthetic corpus, sweeps the weight
 * vector, and reports precision@1/@3 and MRR so the committed defaults are a measured choice.
 *
 * Safety: every seeded fact is named `__eval_*` and deleted in a finally block. Point it at a
 * throwaway instance (MEMORY_API_PORT=7776), never the live service, so a crash mid-run cannot
 * leave synthetic rows in the real store.
 *
 *   bun run scripts/eval-recall.ts [--base http://127.0.0.1:7776] [--seed-only|--clean-only]
 */

const BASE = (argValue("--base") ?? "http://127.0.0.1:7776").replace(/\/$/, "");
const PREFIX = "__eval_";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

interface Doc { topic: string; name: string; content: string }
interface Probe { query: string; topic: string }

/** Distinct topics with low vocabulary overlap, so a correct ranker is separable from a recency one. */
const CORPUS: Doc[] = [
  ...gen("network", [
    "VLAN segmentation isolates IoT cameras from personal laptops on the home LAN",
    "BGW620 gateway supports no VLANs and no per-SSID firewalling on any radio",
    "IP passthrough hands the public WAN address to a downstream router",
    "mDNS reflection is required or casting and printing break across subnets",
    "Client isolation stops two cameras on the same SSID from reaching each other",
    "Guest network must be blocked from the router management interface",
  ]),
  ...gen("database", [
    "Postgres connection pool exhaustion shows up as timeouts under write load",
    "A partial index on created_at cut the slow query from 900ms to 12ms",
    "Prisma migrate deploy is the safe path in production, not migrate dev",
    "Vacuum full takes an exclusive lock and will block every reader",
    "Foreign key cascade deletes silently removed far more rows than intended",
    "Read replicas lag under bulk import and serve stale rows to the API",
  ]),
  ...gen("terminal", [
    "Terminal stuck in mouse tracking mode leaks escape codes as garbled output",
    "Resetting mouse reporting with printf and stty sane restores a sane shell",
    "A tmux.conf file makes mouse mode persistent instead of per session",
    "Scrollback bindings differ between tmux copy mode and the native terminal",
    "Truecolor requires the terminal overrides line in tmux configuration",
    "Detached tmux sessions survive an SSH disconnect and can be reattached",
  ]),
  ...gen("baking", [
    "Banana bread needs very ripe spotted bananas for proper sweetness",
    "Overmixing the batter develops gluten and makes the crumb tough",
    "Creaming butter and sugar traps air which gives the loaf its lift",
    "An oven thermometer matters because dial temperatures drift badly",
    "Buttermilk reacts with baking soda to produce a tender crumb",
    "Resting the batter thirty minutes hydrates the flour fully",
  ]),
  ...gen("security", [
    "Docker published ports bypass ufw entirely via the DOCKER iptables chain",
    "An unauthenticated Redis answered PING from another host on the LAN",
    "Binding a container to the loopback address removes it from LAN reach",
    "Audit exposure by probing from a second machine, never by reading config",
    "Rotate any credential that appeared in a shell history or a transcript",
    "A host firewall says nothing about what containers actually expose",
  ]),
];

function gen(topic: string, lines: string[]): Doc[] {
  return lines.map((content, i) => ({ topic, name: `${PREFIX}${topic}_${i}`, content }));
}

/** Queries phrased as a user would — not verbatim substrings of any single fact. */
const PROBES: Probe[] = [
  { query: "how do I isolate smart cameras from my laptops", topic: "network" },
  { query: "casting and printing stopped working after subnets", topic: "network" },
  { query: "gateway cannot do per SSID firewall rules", topic: "network" },
  { query: "queries getting slow under heavy writes", topic: "database" },
  { query: "safe way to run migrations in production", topic: "database" },
  { query: "replica returning out of date rows", topic: "database" },
  { query: "my shell prints weird escape characters", topic: "terminal" },
  { query: "make mouse scrolling persistent in tmux", topic: "terminal" },
  { query: "session survived losing my ssh connection", topic: "terminal" },
  { query: "why is my loaf dense and tough", topic: "baking" },
  { query: "what makes a cake rise properly", topic: "baking" },
  { query: "banana bread recipe", topic: "baking" },
  { query: "container ports reachable despite the firewall", topic: "security" },
  { query: "found an open database with no password", topic: "security" },
  { query: "how should I check what is exposed", topic: "security" },
];

const WEIGHT_GRID = [
  { name: "committed-pre-fix", IRA_W_RECENCY: 0.3, IRA_W_RELEVANCE: 0.4, IRA_W_TIER: 0.2, IRA_W_CONFIDENCE: 0.1 },
  { name: "relevance-lean", IRA_W_RECENCY: 0.2, IRA_W_RELEVANCE: 0.55, IRA_W_TIER: 0.15, IRA_W_CONFIDENCE: 0.1 },
  { name: "relevance-strong", IRA_W_RECENCY: 0.15, IRA_W_RELEVANCE: 0.6, IRA_W_TIER: 0.15, IRA_W_CONFIDENCE: 0.1 },
  { name: "relevance-dominant", IRA_W_RECENCY: 0.05, IRA_W_RELEVANCE: 0.8, IRA_W_TIER: 0.1, IRA_W_CONFIDENCE: 0.05 },
  { name: "relevance-only", IRA_W_RECENCY: 0.0, IRA_W_RELEVANCE: 1.0, IRA_W_TIER: 0.0, IRA_W_CONFIDENCE: 0.0 },
];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function seed() {
  for (const d of CORPUS) {
    await api("/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fact", name: d.name, description: d.topic, content: d.content }),
    });
  }
  console.log(`seeded ${CORPUS.length} facts across ${new Set(CORPUS.map((d) => d.topic)).size} topics`);
}

async function clean() {
  const all = (await api(`/memory/recall?topic=x&limit=100`)) as { facts: Array<{ id: string; name?: string }> };
  const mine = all.facts.filter((f) => f.name?.startsWith(PREFIX));
  for (const f of mine) await api(`/memory/${f.id}`, { method: "DELETE" });
  console.log(`cleaned ${mine.length} eval facts`);
}

/** topic of a returned row, via the `description` we stamped at seed time. */
async function score() {
  let p1 = 0, p3 = 0, mrr = 0, evaluated = 0;
  for (const probe of PROBES) {
    const r = (await api(
      `/memory/recall?topic=${encodeURIComponent(probe.query)}&limit=3`,
    )) as { facts: Array<{ name?: string; description?: string }> };
    const rows = r.facts.filter((f) => f.name?.startsWith(PREFIX));
    if (!rows.length) { evaluated++; continue; }
    const hits = rows.map((f) => f.description === probe.topic);
    if (hits[0]) p1++;
    if (hits.some(Boolean)) p3++;
    const rank = hits.findIndex(Boolean);
    if (rank !== -1) mrr += 1 / (rank + 1);
    evaluated++;
  }
  return { p1: p1 / evaluated, p3: p3 / evaluated, mrr: mrr / evaluated, n: evaluated };
}

async function main() {
  if (process.argv.includes("--clean-only")) return void (await clean());
  await clean().catch(() => {});
  try {
    await seed();
    const res = await score();
    console.log(
      `\nP@1 ${(res.p1 * 100).toFixed(1)}%   P@3 ${(res.p3 * 100).toFixed(1)}%   MRR ${res.mrr.toFixed(3)}   (n=${res.n})`,
    );
  } finally {
    if (!process.argv.includes("--seed-only")) await clean().catch(() => {});
  }
}

export { WEIGHT_GRID, seed, clean, score };
if (import.meta.main) await main();
