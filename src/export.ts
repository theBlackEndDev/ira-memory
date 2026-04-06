import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "./client.js";
import type { MemoryFact } from "./types.js";

// ─── Sensitive content detection ────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/,                    // OpenAI keys
  /\b(ghp_[a-zA-Z0-9]{36})\b/,                       // GitHub tokens
  /\b(gho_[a-zA-Z0-9]{36})\b/,                       // GitHub OAuth
  /\b(xoxb-[a-zA-Z0-9-]+)\b/,                        // Slack tokens
  /\b(AKIA[A-Z0-9]{16})\b/,                          // AWS access keys
  /\bpassword\s*\w*\s*[:=]\s*["']?[^\s"']+/i,         // Passwords (password is: X, password=X)
  /\bsecret\s*\w*\s*[:=]\s*["']?[^\s"']+/i,           // Secrets
  /\btoken\s*[:=]\s*["']?[^\s"']{20,}/i,             // Long tokens
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,                    // Base64 long strings
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,     // Credit card numbers
  /\b\d{3}-\d{2}-\d{4}\b/,                           // SSN
];

/**
 * Check if content contains sensitive information.
 */
export function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Auto-detect and mark sensitive facts.
 * Returns count of newly marked facts.
 */
export async function detectSensitiveFacts(): Promise<number> {
  const unmarked = await prisma.memoryFact.findMany({
    where: { isSensitive: false, isArchived: false },
  });

  let count = 0;
  for (const fact of unmarked) {
    if (isSensitiveContent(fact.content)) {
      await prisma.memoryFact.update({
        where: { id: fact.id },
        data: { isSensitive: true },
      });
      count++;
    }
  }

  return count;
}

// ─── Export functions ───────────────────────────────────────────

export interface MemoryExport {
  exportedAt: string;
  stats: {
    sessions: number;
    messages: number;
    facts: number;
    summaries: number;
  };
  sessions: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  summaries: Array<Record<string, unknown>>;
}

/**
 * Export all memory as JSON (for backup/transfer).
 */
export async function exportAll(): Promise<MemoryExport> {
  const [sessions, messages, facts, summaries] = await Promise.all([
    prisma.session.findMany({
      include: { messages: true },
      orderBy: { startedAt: "desc" },
    }),
    prisma.message.count(),
    prisma.memoryFact.findMany({
      where: { isArchived: false, supersededBy: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.summary.findMany({ orderBy: { periodStart: "desc" } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    stats: {
      sessions: sessions.length,
      messages,
      facts: facts.length,
      summaries: summaries.length,
    },
    sessions: sessions as unknown as Array<Record<string, unknown>>,
    facts: facts as unknown as Array<Record<string, unknown>>,
    summaries: summaries as unknown as Array<Record<string, unknown>>,
  };
}

/**
 * Export as human-readable markdown (MEMORY.md format).
 * Sensitive facts are excluded.
 * Archived and superseded facts are excluded.
 */
export async function exportMarkdown(): Promise<string> {
  const facts = await prisma.memoryFact.findMany({
    where: {
      isArchived: false,
      supersededBy: null,
      isSensitive: false, // Exclude sensitive
    },
    orderBy: { createdAt: "desc" },
  });

  const summaries = await prisma.summary.findMany({
    where: { scope: { in: ["DAILY", "WEEKLY"] } },
    orderBy: { periodStart: "desc" },
    take: 14, // Last 2 weeks
  });

  // Group facts by category
  const byCategory = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    const existing = byCategory.get(fact.category) ?? [];
    existing.push(fact);
    byCategory.set(fact.category, existing);
  }

  const lines: string[] = [
    "# IRA Memory Export",
    `_Exported: ${new Date().toISOString()}_`,
    `_Active facts: ${facts.length}_`,
    "",
  ];

  // Categories in display order
  const categoryOrder = [
    "PREFERENCE", "CONTEXT", "DECISION", "PLAN", "TODO",
    "PROJECT_STATE", "FACT", "LESSON", "TOOL_CONFIG", "CHECKPOINT",
  ];

  for (const cat of categoryOrder) {
    const catFacts = byCategory.get(cat);
    if (!catFacts || catFacts.length === 0) continue;

    lines.push(`## ${formatCategoryName(cat)}`);
    lines.push("");

    for (const fact of catFacts) {
      const tierBadge = fact.tier === "LONG_TERM" ? "" : ` [${fact.tier}]`;
      lines.push(`- ${fact.content}${tierBadge}`);
    }
    lines.push("");
  }

  if (summaries.length > 0) {
    lines.push("## Recent Summaries");
    lines.push("");
    for (const s of summaries) {
      const date = s.periodStart.toISOString().split("T")[0];
      lines.push(`### ${s.scope} - ${date}`);
      lines.push(s.content);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatCategoryName(cat: string): string {
  return cat
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

// ─── Backup / Restore ───────────────────────────────────────────

const BACKUP_DIR = "/home/hus/golden-claw-workspace/orchestrator/projects/ira-memory/backups";

/**
 * Create a pg_dump backup of the ira_memory database.
 */
export async function backup(): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `ira-memory-${timestamp}.sql`;
  const filepath = join(BACKUP_DIR, filename);

  execSync(
    `docker exec infrastructure-ira-memory-db-1 pg_dump -U ira_memory -d ira_memory > "${filepath}"`,
    { stdio: "pipe" }
  );

  return filepath;
}

/**
 * Restore from a pg_dump file.
 */
export async function restore(filepath: string): Promise<void> {
  execSync(
    `cat "${filepath}" | docker exec -i infrastructure-ira-memory-db-1 psql -U ira_memory -d ira_memory`,
    { stdio: "pipe" }
  );
}
