import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "./client.js";
import { store } from "./store.js";
import { semanticSearch } from "./search.js";
import { getClient, CHAT_MODEL } from "./llm.js";
import type { DiscoverInput, DiscoverResult, DiscoverAspect, LearningType, MemoryCategory } from "./types.js";

const openai = getClient(); // null when IRA_LLM_PROVIDER=none → discovery produces no facts

const DEFAULT_INCLUDE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".md",
  ".py", ".go", ".rs", ".toml", ".prisma", ".sql",
]);

const DEFAULT_EXCLUDE = new Set([
  "node_modules", "dist", ".git", ".next", ".cache", "build",
  "coverage", "__pycache__", ".turbo", ".vercel",
]);

const ASPECT_TO_LEARNING_TYPE: Record<DiscoverAspect, LearningType> = {
  architecture: "INSTITUTIONAL",
  naming: "CODEBASE_RULE",
  api: "INSTITUTIONAL",
  data_models: "INSTITUTIONAL",
  testing: "CODEBASE_RULE",
  dependencies: "INSTITUTIONAL",
};

const ASPECT_TO_CATEGORY: Record<DiscoverAspect, MemoryCategory> = {
  architecture: "CONTEXT",
  naming: "FACT",
  api: "FACT",
  data_models: "FACT",
  testing: "FACT",
  dependencies: "CONTEXT",
};

function buildDiscoverPrompt(aspects: DiscoverAspect[]): string {
  const aspectDescriptions: Record<DiscoverAspect, string> = {
    architecture: "Architecture patterns: folder structure, module boundaries, layering, separation of concerns",
    naming: "Naming conventions: variable naming, file naming, function naming patterns",
    api: "API contracts: endpoints, request/response shapes, authentication patterns",
    data_models: "Data models: schemas, entity relationships, data flow",
    testing: "Testing patterns: test organization, frameworks used, assertion styles, coverage approach",
    dependencies: "Dependencies: key libraries, their roles, version constraints, why they were chosen",
  };

  const aspectList = aspects
    .map((a) => `- ${aspectDescriptions[a]}`)
    .join("\n");

  return `You analyze source code to discover implicit project knowledge. Given source files, extract knowledge about:

${aspectList}

Rules:
- Focus on PATTERNS, not individual implementation details
- Each discovery should be a reusable insight about how this project works
- Include specific file paths as evidence
- Rate confidence based on how consistently the pattern appears across files
- Skip trivially obvious things (e.g., "this project uses TypeScript")
- Prefer insights that would help a new developer understand the project

Respond in this exact JSON format:
{"discoveries": [{"aspect": "architecture|naming|api|data_models|testing|dependencies", "content": "...", "confidence": 0.9, "evidence": ["file1.ts", "file2.ts"]}]}`;
}

/**
 * Recursively collect files from a directory, respecting include/exclude patterns.
 */
async function collectFiles(
  dir: string,
  rootDir: string,
  includeExts: Set<string>,
  excludeDirs: Set<string>,
  maxFiles: number,
  collected: string[] = [],
): Promise<string[]> {
  if (collected.length >= maxFiles) return collected;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (collected.length >= maxFiles) break;

    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      await collectFiles(join(dir, entry.name), rootDir, includeExts, excludeDirs, maxFiles, collected);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (includeExts.has(ext)) {
        collected.push(join(dir, entry.name));
      }
    }
  }

  return collected;
}

/**
 * Compute a hash of the directory state for change detection.
 */
async function computeDirHash(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const f of files.slice(0, 200)) {
    try {
      const s = await stat(f);
      hash.update(`${f}:${s.mtimeMs}`);
    } catch {
      hash.update(`${f}:missing`);
    }
  }
  return hash.digest("hex");
}

/**
 * Scan source code directories and extract implicit knowledge.
 * Discovers architecture patterns, naming conventions, API contracts, etc.
 */
export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  const maxFiles = input.maxFiles ?? 100;
  const aspects = input.aspects ?? ["architecture", "naming", "api", "data_models", "testing", "dependencies"];

  // Build include/exclude sets
  const includeExts = input.include
    ? new Set(input.include.map((p) => p.startsWith(".") ? p : `.${p}`))
    : DEFAULT_INCLUDE_EXTS;
  const excludeDirs = input.exclude
    ? new Set(input.exclude)
    : DEFAULT_EXCLUDE;

  // Collect files
  const files = await collectFiles(input.directory, input.directory, includeExts, excludeDirs, maxFiles);

  if (files.length === 0) {
    return { directory: input.directory, filesScanned: 0, discoveries: [], totalDiscovered: 0 };
  }

  // Check sync record (skip if already scanned and hash matches)
  const dirHash = await computeDirHash(files);
  if (!input.force) {
    const existing = await prisma.fileSyncRecord.findUnique({
      where: { filePath: input.directory },
    });
    if (existing && existing.fileHash === dirHash) {
      return { directory: input.directory, filesScanned: 0, discoveries: [], totalDiscovered: 0 };
    }
  }

  // Read file contents and build analysis chunks (~10000 chars each)
  const chunks: string[] = [];
  let currentChunk = "";

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const relPath = relative(input.directory, filePath);
      // Take first 150 lines per file
      const lines = content.split("\n").slice(0, 150).join("\n");
      const block = `\n=== FILE: ${relPath} ===\n${lines}\n`;

      if (currentChunk.length + block.length > 10000) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = block;
      } else {
        currentChunk += block;
      }
    } catch {
      // Skip unreadable files
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  // Process each chunk with LLM
  const systemPrompt = buildDiscoverPrompt(aspects);
  const allDiscoveries: Array<{
    aspect: DiscoverAspect;
    content: string;
    confidence: number;
    evidence: string[];
  }> = [];

  for (const chunk of chunks) {
    if (!openai) break; // no LLM provider → no discoveries (allDiscoveries stays empty)
    try {
      const llmResponse = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Analyze these source files:\n${chunk}` },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      });

      const parsed = JSON.parse(llmResponse.choices[0].message.content ?? "{}");
      if (parsed.discoveries && Array.isArray(parsed.discoveries)) {
        for (const d of parsed.discoveries) {
          if (aspects.includes(d.aspect as DiscoverAspect)) {
            allDiscoveries.push({
              aspect: d.aspect as DiscoverAspect,
              content: d.content,
              confidence: typeof d.confidence === "number" ? d.confidence : 0.7,
              evidence: Array.isArray(d.evidence) ? d.evidence : [],
            });
          }
        }
      }
    } catch (err) {
      console.error(`[discover] LLM chunk error:`, err);
    }
  }

  // Dedup and store discoveries
  const result: DiscoverResult = {
    directory: input.directory,
    filesScanned: files.length,
    discoveries: [],
    totalDiscovered: 0,
  };

  for (const disc of allDiscoveries) {
    // Dedup against existing discovered facts
    try {
      const similar = await semanticSearch({
        query: disc.content,
        tables: ["facts"],
        limit: 2,
        threshold: 0.85,
      });
      if (similar.facts.length > 0) continue;
    } catch {
      // Non-fatal
    }

    const learningType = ASPECT_TO_LEARNING_TYPE[disc.aspect];
    const category = ASPECT_TO_CATEGORY[disc.aspect];
    const tags = ["discovered", disc.aspect];
    if (input.projectName) tags.push(input.projectName.toLowerCase());

    const fact = await store({
      category,
      content: disc.content,
      tier: "DAILY",
      source: "inferred",
      sourceRef: input.directory,
      confidence: disc.confidence,
      tags,
      learningType,
      provenance: "discovered",
      metadata: { evidence: disc.evidence, aspect: disc.aspect },
    });

    result.discoveries.push({
      fact,
      aspect: disc.aspect,
      confidence: disc.confidence,
      evidence: disc.evidence,
    });
  }

  result.totalDiscovered = result.discoveries.length;

  // Record sync
  await prisma.fileSyncRecord.upsert({
    where: { filePath: input.directory },
    update: { fileHash: dirHash, syncedAt: new Date(), factCount: result.totalDiscovered },
    create: { filePath: input.directory, fileHash: dirHash, factCount: result.totalDiscovered },
  });

  return result;
}
