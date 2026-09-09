// Pure unit test for deriveProjectSlug — no DB, no network. Kept separate
// from test-e2e.ts (which requires a live Postgres) so `bun test` can run
// this one in CI without a database.
//
// Parity contract: the pi extension (~/.pi/agent/extensions/memory/slug.ts,
// projectSlugForCwd) implements the identical three-rule algorithm and
// carries the same fixture list in its slug.test.ts. There is no shared
// package between the two repos — if you change the algorithm here, change
// it there too, and re-run both.

import { deriveProjectSlug } from "./summarize.js";

let pass = 0;
let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

// --- nested paths collapse to the project root ---
check("nested path collapses to project root", deriveProjectSlug("/Users/hus/Projects/ira-memory/src/db"), "ira-memory");
check("project root, no trailing slash", deriveProjectSlug("/Users/hus/Projects/ira-memory"), "ira-memory");
check("project root, trailing slash", deriveProjectSlug("/Users/hus/Projects/ira-memory/"), "ira-memory");

// --- Projects root catch-all — deliberate, not a bug (plan D2) ---
check("Projects root, absolute", deriveProjectSlug("/Users/hus/Projects"), "Projects");
check("Projects root, trailing slash", deriveProjectSlug("/Users/hus/Projects/"), "Projects");
check("Projects root, tilde", deriveProjectSlug("~/Projects"), "Projects");
check("Projects root works for ANY home dir — no hardcode", deriveProjectSlug("/home/otheruser/Projects"), "Projects");
check("server layout root, lowercase", deriveProjectSlug("/orchestrator/projects"), "Projects");

// --- server layout, lowercase segment ---
check("lowercase nested segment (server layout)", deriveProjectSlug("/orchestrator/projects/widget-api/src"), "widget-api");

// --- outside-Projects fallback (Phase 1, plan D2/D6) ---
check("outside Projects falls back to basename, not null", deriveProjectSlug("/Users/hus/.pi/agent/extensions/memory"), "memory");
check("bare home dir falls back to its basename", deriveProjectSlug("/Users/hus"), "hus");
check("false-positive guard: 'MyProjects' is not 'Projects'", deriveProjectSlug("/Users/hus/MyProjects"), "MyProjects");

// --- null/empty only ---
check("null cwd returns null", deriveProjectSlug(null), null);
check("undefined cwd returns null", deriveProjectSlug(undefined), null);
check("empty string returns null", deriveProjectSlug(""), null);

// --- parity fixtures shared with the pi extension's slug.test.ts ---
const PARITY_FIXTURES: Array<[cwd: string, slug: string | null]> = [
  ["/Users/hus/Projects/ira-memory/src/db", "ira-memory"],
  ["/Users/hus/Projects/ira-memory", "ira-memory"],
  ["/Users/hus/Projects", "Projects"],
  ["~/Projects/", "Projects"],
  ["/orchestrator/projects/widget-api", "widget-api"],
  ["/Users/hus/.pi/agent/extensions/memory", "memory"],
  ["/Users/hus/MyProjects", "MyProjects"],
  ["", null],
];
for (const [cwd, want] of PARITY_FIXTURES) {
  check(`parity fixture: ${JSON.stringify(cwd)}`, deriveProjectSlug(cwd), want);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
