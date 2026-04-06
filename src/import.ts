import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "./client.js";
import { store } from "./store.js";
import type { ImportInput, ImportResult } from "./types.js";
import type { MemoryCategory, MemoryTier } from "@prisma/client";

export async function importFromFiles(input: ImportInput): Promise<ImportResult> {
  const result: ImportResult = {
    filesProcessed: 0,
    factsCreated: 0,
    factsSkipped: 0,
    errors: [],
  };

  // Import MEMORY.md
  try {
    await importMemoryMd(input.memoryMdPath, input.force ?? false, result);
  } catch (err) {
    result.errors.push(`MEMORY.md: ${err}`);
  }

  // Import daily memory files
  try {
    const files = await readdir(input.dailyDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      try {
        await importDailyFile(join(input.dailyDir, file), input.force ?? false, result);
      } catch (err) {
        result.errors.push(`${file}: ${err}`);
      }
    }
  } catch (err) {
    result.errors.push(`Daily dir: ${err}`);
  }

  return result;
}

async function importMemoryMd(
  filePath: string,
  force: boolean,
  result: ImportResult
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");

  // Check if already synced
  if (!force) {
    const existing = await prisma.fileSyncRecord.findUnique({
      where: { filePath },
    });
    if (existing && existing.fileHash === hash) {
      result.factsSkipped++;
      return;
    }
  }

  result.filesProcessed++;

  // Parse MEMORY.md sections into facts
  const sections = parseMarkdownSections(content);
  let factCount = 0;

  for (const section of sections) {
    const category = inferCategory(section.heading);
    const tier: MemoryTier = "LONG_TERM";

    // Each bullet point or paragraph becomes a fact
    const items = extractItems(section.body);
    for (const item of items) {
      if (item.trim().length < 5) continue;

      await store({
        category,
        content: item.trim(),
        tier,
        source: "imported",
        sourceRef: filePath,
        tags: [section.heading.toLowerCase().replace(/\s+/g, "-")],
      });
      factCount++;
      result.factsCreated++;
    }
  }

  // Record sync
  await prisma.fileSyncRecord.upsert({
    where: { filePath },
    update: { fileHash: hash, syncedAt: new Date(), factCount },
    create: { filePath, fileHash: hash, factCount },
  });
}

async function importDailyFile(
  filePath: string,
  force: boolean,
  result: ImportResult
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");

  if (!force) {
    const existing = await prisma.fileSyncRecord.findUnique({
      where: { filePath },
    });
    if (existing && existing.fileHash === hash) {
      result.factsSkipped++;
      return;
    }
  }

  result.filesProcessed++;

  // Determine tier from filename
  const filename = basename(filePath);
  const isWeekly = filename.includes("WEEK");
  const tier: MemoryTier = isWeekly ? "DAILY" : "SHORT_TERM";

  // Parse into sections and facts
  const sections = parseMarkdownSections(content);
  let factCount = 0;

  for (const section of sections) {
    const category = inferCategory(section.heading);
    const items = extractItems(section.body);

    for (const item of items) {
      if (item.trim().length < 5) continue;

      // Try to extract date from filename for context
      const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
      const dateTag = dateMatch ? dateMatch[1] : undefined;

      await store({
        category,
        content: item.trim(),
        tier,
        source: "imported",
        sourceRef: filePath,
        tags: [
          section.heading.toLowerCase().replace(/\s+/g, "-"),
          ...(dateTag ? [dateTag] : []),
        ],
      });
      factCount++;
      result.factsCreated++;
    }
  }

  await prisma.fileSyncRecord.upsert({
    where: { filePath },
    update: { fileHash: hash, syncedAt: new Date(), factCount },
    create: { filePath, fileHash: hash, factCount },
  });
}

// ─── Helpers ────────────────────────────────────────────────────

interface Section {
  heading: string;
  body: string;
}

function parseMarkdownSections(content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split("\n");
  let currentHeading = "general";
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0) {
        sections.push({
          heading: currentHeading,
          body: currentBody.join("\n"),
        });
      }
      currentHeading = headingMatch[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n") });
  }

  return sections;
}

function extractItems(body: string): string[] {
  const items: string[] = [];
  const lines = body.split("\n");
  let currentItem = "";

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)/);
    if (bulletMatch) {
      if (currentItem) items.push(currentItem);
      currentItem = bulletMatch[1];
    } else if (line.trim() === "") {
      if (currentItem) items.push(currentItem);
      currentItem = "";
    } else if (currentItem) {
      currentItem += " " + line.trim();
    } else if (line.trim().length > 10) {
      // Standalone paragraph
      items.push(line.trim());
    }
  }

  if (currentItem) items.push(currentItem);
  return items;
}

function inferCategory(heading: string): MemoryCategory {
  const h = heading.toLowerCase();

  if (h.includes("decision") || h.includes("decided")) return "DECISION";
  if (h.includes("plan") || h.includes("roadmap") || h.includes("next")) return "PLAN";
  if (h.includes("todo") || h.includes("task") || h.includes("action")) return "TODO";
  if (h.includes("preference") || h.includes("likes") || h.includes("style")) return "PREFERENCE";
  if (h.includes("lesson") || h.includes("learned") || h.includes("avoid")) return "LESSON";
  if (h.includes("context") || h.includes("background") || h.includes("about")) return "CONTEXT";
  if (h.includes("tool") || h.includes("config") || h.includes("setup")) return "TOOL_CONFIG";
  if (h.includes("project") || h.includes("status") || h.includes("state")) return "PROJECT_STATE";
  if (h.includes("checkpoint") || h.includes("resume") || h.includes("recovery")) return "CHECKPOINT";

  return "FACT";
}
