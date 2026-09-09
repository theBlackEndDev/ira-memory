// Redaction — Phase 2 engine chain (betterleaks -> gitleaks -> heuristic).
// See specs/../Plans/pi-ira-memory-capture.md D4/D8.
//
// Applied before storeMessage AND before embedding, never after. Once a row
// is written it is in the WAL and in every backup taken since; redacting
// later does not recall it.
//
// Engine chain, COMPOSED not waterfalled — see the note below on why a pure
// waterfall was wrong:
//   1. betterleaks (brew install betterleaks) — BPE rarity + contextual
//      filtering, so it does NOT flag prose that merely mentions a pattern
//      or an already-redacted placeholder (the false positive the Phase 1
//      heuristic tier had — see the FP check in pi-capture's Phase 2 tests).
//   2. gitleaks (fallback if betterleaks isn't installed) — same RawFinding
//      JSON schema, less precise but a real secrets scanner, not a regex guess.
//   3. heuristic (redact.ts's own regex rules, Phase 1) — always available,
//      zero external dependency, runs on the CLI-redacted output.
//
// CORRECTION found during Phase 4's real-data verification: a real Anthropic
// session key (`sk-ant-sid01-...`) sitting in a tool result was NOT caught by
// EITHER betterleaks or gitleaks — both are keyword/context-gated (they look
// for a nearby "KEY="/"TOKEN=" trigger or a recognized provider prefix in
// their ruleset) and this string's surrounding code (`injectedKey = "..."`)
// didn't trigger either. Verified directly: `echo '<the key>' | betterleaks
// stdin ...` and the gitleaks equivalent both returned `[]`. A pure waterfall
// ("use the best engine available, ignore the rest") treats the CLI engines'
// silence as authoritative — which is exactly backwards per D8
// ("under-redaction is not recoverable"). Heuristic's dumb `sk-[A-Za-z0-9_-]
// {20,}` prefix match, with no context requirement at all, catches this key
// where both real scanners missed it.
//
// So the heuristic pass now ALWAYS runs, layered on top of whatever the CLI
// engine already redacted — not only when no CLI engine is installed. This
// does reopen some of Phase 1's over-redaction (e.g. prose that merely
// mentions a KEY=value shape can still get flagged) — that is the accepted,
// explicitly-designed-for cost of D8's asymmetry: a benign line getting a
// `[REDACTED]` placeholder is recoverable by re-import from pi's untouched
// JSONL; a real key silently surviving in Postgres is not.
//
// Batched, not per-message: per the plan, betterleaks/gitleaks are CLI
// binaries with real process-spawn overhead, so a session with hundreds of
// messages must not spawn hundreds of processes. `redactBatch` scans every
// pending message's text in ONE subprocess call per sync and splits the
// result back per message; the heuristic layer that runs after it is pure
// synchronous regex, so layering it in costs no additional subprocess calls.

const PLACEHOLDER = "[REDACTED]";
/** Separator between messages in a batch scan. A null byte + rare token, so
 * it can never collide with real content and a finding can never span it. */
const BATCH_SEPARATOR = "\n\n\x00IRA_MSG_SEP\x00\n\n";
const SCAN_TIMEOUT_MS = 10_000;

export type RedactionEngine = "betterleaks" | "gitleaks" | "heuristic" | "betterleaks+heuristic" | "gitleaks+heuristic";

export interface RedactionResult {
  content: string;
  redacted: boolean;
  count: number;
  engine: RedactionEngine;
}

export interface BatchRedactionResult {
  texts: string[];
  redacted: boolean[];
  counts: number[];
  engine: RedactionEngine;
}

// ── Tier 3: heuristic (Phase 1, unchanged) ──────────────────────────────

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: "openai_key", pattern: /\b(sk-[A-Za-z0-9_-]{20,})\b/g },
  { name: "github_token", pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,})\b/g },
  { name: "slack_token", pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { name: "aws_access_key", pattern: /\b(AKIA[A-Z0-9]{16})\b/g },
  { name: "private_key_block", pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g },
  { name: "bearer_token", pattern: /\bBearer\s+([A-Za-z0-9._-]{20,})/gi },
  { name: "conn_string_creds", pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\/\s]+:([^@\/\s]+)@/g },
  { name: "kv_assignment", pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?)\s*[:=]\s*["']?([^\s"'\n,;]{6,})["']?/g },
  { name: "base64_blob", pattern: /\b([A-Za-z0-9+/]{40,}={0,2})\b/g },
];

/** Pure, synchronous, zero-dependency redaction. Tier 3 — always available. */
export function redactHeuristic(content: string): RedactionResult {
  let result = content;
  let count = 0;

  for (const rule of RULES) {
    if (rule.name === "kv_assignment") {
      result = result.replace(rule.pattern, (_full, keyName: string) => {
        count++;
        return `${keyName}=${PLACEHOLDER}`;
      });
      continue;
    }
    result = result.replace(rule.pattern, (full: string, group1?: string) => {
      count++;
      if (group1 !== undefined) return full.replace(group1, PLACEHOLDER);
      return PLACEHOLDER;
    });
  }

  return { content: result, redacted: count > 0, count, engine: "heuristic" };
}

// ── Tiers 1 & 2: CLI scanners (betterleaks, gitleaks) ───────────────────

interface RawFinding {
  RuleID: string;
  Description: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
  Match: string;
  Secret: string;
}

const BETTERLEAKS_ARGS = [
  "stdin", "--report-path", "-", "--report-format", "json",
  "--validation=false", "--no-banner", "--no-color", "--log-level", "error", "--exit-code", "0",
];
const GITLEAKS_ARGS = [
  "stdin", "--report-path", "-", "--report-format", "json",
  "--no-banner", "--log-level", "error", "--exit-code", "0",
];

/**
 * Run a gitleaks-schema CLI scanner over `input` via stdin. Returns `null`
 * (never throws) if the binary is missing, times out, or produces output
 * that doesn't parse — any of which means "try the next tier down".
 */
// Exported for redact.test.ts only: the real failure mode this whole chain
// depends on is "binary not found" (ENOENT), and the reliable way to trigger
// that in a test is a nonexistent binary name — Bun.spawn resolves PATH at
// call time from its own internal cache, so mutating process.env.PATH after
// startup does NOT reliably affect subsequent spawn resolution (verified: it
// doesn't). A bogus binary name sidesteps that entirely.
export async function runScanner(binary: string, args: string[], input: string): Promise<RawFinding[] | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null; // ENOENT — binary not installed
  }

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, SCAN_TIMEOUT_MS);

  try {
    proc.stdin.write(input);
    await proc.stdin.end();
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as RawFinding[]) : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Absolute char offset of a 1-based (line, column) position in `content`. */
function lineColToOffset(content: string, line: number, column: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + (column - 1);
}

/**
 * Locate the exact span of `finding.Secret` in `content`, anchored near the
 * line/col the scanner reported (fuzzy re-locate — mirrors the proven
 * approach in moyai-ai/pi-betterleaks-scanner's process-scanner.ts, since
 * betterleaks reports line/column, not byte offsets, and column semantics
 * can drift slightly on unusual whitespace). Returns null if the secret text
 * can't be found at all (should not happen against the same content that was
 * scanned, but must not crash the import if it somehow does).
 */
function locateSecretSpan(content: string, finding: RawFinding): { start: number; end: number } | null {
  const approxStart = lineColToOffset(content, finding.StartLine, finding.StartColumn);
  let idx = content.indexOf(finding.Secret, Math.max(0, approxStart - finding.Match.length));
  if (idx === -1) idx = content.indexOf(finding.Secret);
  if (idx === -1) return null;
  return { start: idx, end: idx + finding.Secret.length };
}

/** Replace every located finding span with the placeholder, merging overlaps. */
function applyFindings(content: string, findings: RawFinding[]): { content: string; count: number } {
  const spans: { start: number; end: number }[] = [];
  for (const f of findings) {
    const span = locateSecretSpan(content, f);
    if (span) spans.push(span);
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  let result = "";
  let cursor = 0;
  for (const m of merged) {
    result += content.slice(cursor, m.start) + PLACEHOLDER;
    cursor = m.end;
  }
  result += content.slice(cursor);
  return { content: result, count: merged.length };
}

/** Scan `input` once through the engine chain. Never throws. */
async function scan(input: string): Promise<{ findings: RawFinding[]; engine: RedactionEngine } | null> {
  const betterleaksResult = await runScanner("betterleaks", BETTERLEAKS_ARGS, input);
  if (betterleaksResult !== null) return { findings: betterleaksResult, engine: "betterleaks" };

  const gitleaksResult = await runScanner("gitleaks", GITLEAKS_ARGS, input);
  if (gitleaksResult !== null) return { findings: gitleaksResult, engine: "gitleaks" };

  return null; // both CLIs unavailable — caller falls back to heuristic
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Layer the heuristic pass on top of a (possibly null/empty) CLI result. The
 * heuristic ALWAYS runs — see the module docstring for why a pure waterfall
 * missed a real secret — so this composes the two rather than picking one.
 */
function layerHeuristic(
  cliContent: string,
  cliRedacted: boolean,
  cliCount: number,
  cliEngine: RedactionEngine | null,
): RedactionResult {
  const heuristicPass = redactHeuristic(cliContent);
  if (!heuristicPass.redacted) {
    return cliRedacted
      ? { content: cliContent, redacted: true, count: cliCount, engine: cliEngine! }
      : { content: cliContent, redacted: false, count: 0, engine: cliEngine ?? "heuristic" };
  }
  const combinedEngine: RedactionEngine =
    cliEngine === "betterleaks" ? "betterleaks+heuristic" : cliEngine === "gitleaks" ? "gitleaks+heuristic" : "heuristic";
  return { content: heuristicPass.content, redacted: true, count: cliCount + heuristicPass.count, engine: combinedEngine };
}

/** Single-text convenience wrapper around the engine chain, for callers with exactly one string (tests, ad hoc use). */
export async function redactSecrets(content: string): Promise<RedactionResult> {
  if (!content) return { content, redacted: false, count: 0, engine: "heuristic" };

  const scanned = await scan(content);
  if (!scanned || scanned.findings.length === 0) {
    return layerHeuristic(content, false, 0, scanned?.engine ?? null);
  }

  const { content: cliRedactedContent, count } = applyFindings(content, scanned.findings);
  return layerHeuristic(cliRedactedContent, count > 0, count, scanned.engine);
}

/**
 * Redact every text in `texts` with ONE subprocess call, not one per text.
 * This is the entry point pi-capture.ts uses — a sync can carry dozens of
 * new messages, and spawning a CLI scanner per message is real, avoidable
 * process overhead.
 */
export async function redactBatch(texts: string[]): Promise<BatchRedactionResult> {
  if (texts.length === 0) return { texts: [], redacted: [], counts: [], engine: "heuristic" };

  const combined = texts.join(BATCH_SEPARATOR);
  const scanned = await scan(combined);

  let cliTexts: string[];
  let cliRedactedFlags: boolean[];
  let cliCounts: number[];
  let cliEngine: RedactionEngine | null;

  if (!scanned || scanned.findings.length === 0) {
    cliTexts = texts;
    cliRedactedFlags = texts.map(() => false);
    cliCounts = texts.map(() => 0);
    cliEngine = scanned?.engine ?? null;
  } else {
    const { content: redactedCombined } = applyFindings(combined, scanned.findings);
    const parts = redactedCombined.split(BATCH_SEPARATOR);
    if (parts.length === texts.length) {
      cliTexts = parts;
      cliRedactedFlags = parts.map((p, i) => p !== texts[i]);
      cliCounts = parts.map((p) => (p.match(/\[REDACTED\]/g) ?? []).length);
      cliEngine = scanned.engine;
    } else {
      // Separator got split by a finding somehow (shouldn't happen — it's a
      // null byte, no ruleset matches across it) — fail safe to unredacted-
      // by-CLI rather than misalign redacted text to the wrong message. The
      // heuristic pass below still runs per-text regardless.
      cliTexts = texts;
      cliRedactedFlags = texts.map(() => false);
      cliCounts = texts.map(() => 0);
      cliEngine = null;
    }
  }

  // Heuristic ALWAYS runs on top, per-text (pure regex, no subprocess cost) —
  // see the module docstring: CLI engines are context-gated and can miss a
  // real secret entirely, which heuristic's dumber prefix matching catches.
  const finalTexts: string[] = [];
  const finalRedacted: boolean[] = [];
  const finalCounts: number[] = [];
  const finalEngines: RedactionEngine[] = [];
  for (let i = 0; i < texts.length; i++) {
    const layered = layerHeuristic(cliTexts[i], cliRedactedFlags[i], cliCounts[i], cliEngine);
    finalTexts.push(layered.content);
    finalRedacted.push(layered.redacted);
    finalCounts.push(layered.count);
    finalEngines.push(layered.engine);
  }

  // engine field is batch-level for callers that just want "what ran"; use
  // the richest engine tag actually seen (prefers CLI+heuristic combos).
  const engine =
    finalEngines.find((e) => e === "betterleaks+heuristic") ??
    finalEngines.find((e) => e === "gitleaks+heuristic") ??
    cliEngine ??
    "heuristic";

  return { texts: finalTexts, redacted: finalRedacted, counts: finalCounts, engine };
}
