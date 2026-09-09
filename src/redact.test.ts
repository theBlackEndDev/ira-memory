// Phase 2 redaction engine chain: betterleaks -> gitleaks -> heuristic.
// No DB dependency — pure/subprocess only, safe to run in CI.

import { redactSecrets, redactBatch, redactHeuristic, runScanner } from "./redact.js";

/** Test-only helper: run just the CLI layer (betterleaks -> gitleaks), no heuristic on top. */
async function scanCliOnly(text: string): Promise<unknown[] | null> {
  const bl = await runScanner("betterleaks", ["stdin", "--report-path", "-", "--report-format", "json", "--validation=false", "--no-banner", "--no-color", "--log-level", "error", "--exit-code", "0"], text);
  if (bl !== null) return bl;
  return runScanner("gitleaks", ["stdin", "--report-path", "-", "--report-format", "json", "--no-banner", "--log-level", "error", "--exit-code", "0"], text);
}
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function assert(condition: boolean, name: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`);
  }
}

// A realistic (high-entropy) fake secret. Real scanners reject sequential/
// low-entropy strings on purpose (that's the "rare not random" filtering
// this phase exists to get) — a fixture must look like an actual key.
const REALISTIC_KEY = "sk-proj-Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr";
const REALISTIC_GH_TOKEN = "ghp_9kR2mLxQ7pTvN4wYbF8sJhAeUiK3oXcZgD6nR2mLxQ7pT";
// Synthetic key in the SAME shape as a real one found in this codebase's own
// session transcripts during Phase 4 backfill (sk-ant-sid01- prefix, same
// rough length/charset) — NOT the real value; that would be a secret in the
// repo, which is exactly the class of bug this test exists to catch. Neither
// betterleaks nor gitleaks recognize this Anthropic session-key shape at all
// (verified directly against the real key: both returned `[]`), and the
// surrounding code (`injectedKey = "..."`) doesn't trigger either engine's
// keyword prefilter. This is the exact miss that corrected the engine chain
// from a waterfall to a composed (CLI + always-on heuristic) design — see
// redact.ts's module docstring.
const MISSED_BY_CLI_ENGINES = "sk-ant-sid01-4PlXsKK9dC2N4PIFwjhXiYlnlVx1jCwO-bq3ILKbvhz3eWbkrb8XY-G8b8CRl02hPoiOH4JMXQvvvnk1uX-FTghjNkgQPDROGgYF9eO9EyX-OSyRp3Ok_niam";

async function main() {
  // --- redactHeuristic: pure function, unchanged from Phase 1 ---
  {
    const r = redactHeuristic("OPENAI_API_KEY=sk-proj-abc123def456ghi789jklmnop");
    assert(r.redacted && r.engine === "heuristic", "redactHeuristic still works standalone");
  }

  // --- engine chain picks a real scanner when installed ---
  {
    const r = await redactSecrets(`OPENAI_API_KEY=${REALISTIC_KEY}`);
    assert(r.redacted, "realistic key is caught by the installed engine chain");
    assert(!r.content.includes(REALISTIC_KEY), "the actual secret value does not survive");
    assert(r.content.includes("OPENAI_API_KEY="), "surrounding context (key name) survives");
    // Both the CLI engine AND heuristic match this key shape, so the engine
    // tag reflects both having contributed — that's the corrected, composed
    // design (see redact.ts's module docstring), not a bug.
    assert(r.engine.includes("betterleaks") || r.engine.includes("gitleaks"), `engine includes a real scanner, not heuristic-only — got ${r.engine}`);
  }

  // --- the CLI engines alone do NOT flag this (Phase 2's original goal) ---
  // This is still true and still worth proving: betterleaks/gitleaks, taken
  // alone, correctly ignore prose that merely mentions a KEY=value shape.
  // What changed (see below) is that the FINAL composed result no longer
  // relies on the CLI engines' silence as authoritative.
  {
    const prose = "the surrounding name — `OPENAI_API_KEY=[REDACTED]` preserves the meaning";
    const cliOnly = await scanCliOnly(prose);
    assert(cliOnly !== null && cliOnly.length === 0, "betterleaks/gitleaks ALONE find nothing in prose about an already-redacted key");
  }

  // --- the corrected behavior: heuristic still catches what CLI engines miss ---
  // A pure "prefer the accurate engine" design would have left this exact
  // secret in Postgres forever (it did, briefly, during Phase 4's real
  // backfill — this test is the regression guard for that).
  {
    const r = await redactSecrets(`let injectedKey = "${MISSED_BY_CLI_ENGINES}"`);
    assert(r.redacted, "the Anthropic-key-shaped secret IS caught by the composed engine (heuristic layer)");
    assert(!r.content.includes(MISSED_BY_CLI_ENGINES), "the real secret value does not survive");
    assert(r.engine === "betterleaks+heuristic" || r.engine === "gitleaks+heuristic" || r.engine === "heuristic", `engine tag reflects heuristic's contribution — got ${r.engine}`);
  }

  // --- accepted cost of the correction: the plan-doc FP returns ---
  // Documented, not silently regressed: D8's own asymmetry ( over-redaction
  // recoverable, under-redaction not) is why this is the right trade to make.
  {
    const planPath = "/Users/hus/Projects/Plans/pi-ira-memory-capture.md";
    let planText: string | null = null;
    try {
      planText = readFileSync(planPath, "utf-8");
    } catch {
      // Plan doc may not exist in every environment this test runs in — skip gracefully.
    }
    if (planText) {
      const r = await redactSecrets(planText);
      assert(r.redacted, `plan doc IS flagged (heuristic layer catches its own KEY=[REDACTED] example prose — accepted D8 trade-off) — engine=${r.engine}, count=${r.count}`);
    } else {
      console.log("  (skipped: plan doc not found at " + planPath + ")");
    }
  }

  // --- redactBatch: one scan, multiple texts, correctly split back ---
  {
    const texts = [
      "just a normal message about deploying the app",
      `here's the token: ${REALISTIC_GH_TOKEN} — save it somewhere safe`,
      "another normal message, nothing to see here",
    ];
    const batch = await redactBatch(texts);
    assert(batch.texts.length === 3, "batch returns one entry per input text");
    assert(!batch.redacted[0], "batch[0]: untouched normal text");
    assert(batch.redacted[1] === true, "batch[1]: secret caught");
    assert(!batch.texts[1].includes(REALISTIC_GH_TOKEN), "batch[1]: secret value removed");
    assert(batch.texts[1].includes("here's the token:"), "batch[1]: surrounding context preserved");
    assert(!batch.redacted[2], "batch[2]: untouched normal text (not corrupted by batching)");
    assert(batch.texts[2] === texts[2], "batch[2]: byte-identical to input");
  }

  // --- empty input ---
  {
    const empty = await redactBatch([]);
    assert(empty.texts.length === 0, "empty batch returns empty");
  }

  // --- fallback chain: a missing binary returns null, not a throw ---
  // This is the exact failure mode redactSecrets/redactBatch depend on to
  // fall through betterleaks -> gitleaks -> heuristic. (Testing this via a
  // real "no scanner installed" environment isn't reliably reproducible here
  // since Bun.spawn resolves PATH from an internal cache at call time, not
  // from process.env.PATH mutated at runtime — verified directly. A bogus
  // binary name exercises the same ENOENT path deterministically.)
  {
    const missing = await runScanner("this-binary-does-not-exist-ira-memory-test", [], "anything");
    assert(missing === null, "runScanner returns null (not a throw) for a nonexistent binary");
  }

  // --- and the documented consequence: redactHeuristic alone is what a
  // real "nothing installed" environment would fall back to. ---
  {
    const r = redactHeuristic("OPENAI_API_KEY=sk-proj-abc123def456ghi789jklmnop");
    assert(r.redacted && r.engine === "heuristic", "heuristic tier alone still redacts an obviously-shaped secret");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

// Top-level await, not fire-and-forget: `bun test` evaluates each file's
// module body and moves on once it returns — an unawaited async main() had
// its console.log output silently dropped because the file was considered
// "done" before the promise resolved. `bun run src/redact.test.ts` never hit
// this (a plain script process stays alive for pending promises), which is
// why it looked fine standalone and only broke under the actual `test` script.
await main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
