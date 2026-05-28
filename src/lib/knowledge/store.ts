import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { KnowledgeBase, KnowledgeEntry } from "@/lib/types/knowledge";

const KB_PATH = join(process.cwd(), "knowledge", "base.json");

let cachedKB: KnowledgeBase | null = null;

export async function loadKnowledgeBase(): Promise<KnowledgeBase> {
  if (cachedKB) return cachedKB;

  try {
    const data = await readFile(KB_PATH, "utf-8");
    cachedKB = JSON.parse(data) as KnowledgeBase;
  } catch {
    cachedKB = { entries: [] };
  }

  return cachedKB;
}

export async function saveKnowledgeBase(kb: KnowledgeBase): Promise<void> {
  await writeFile(KB_PATH, JSON.stringify(kb, null, 2), "utf-8");
  cachedKB = kb;
}

export async function addEntry(entry: KnowledgeEntry): Promise<void> {
  const kb = await loadKnowledgeBase();

  // Upsert: if a lesson with the same description+fixApplied exists, update it
  if (entry.category === "verification_lesson") {
    const desc = (entry.content as Record<string, unknown>).description;
    const fix = (entry.content as Record<string, unknown>).fixApplied;
    const existing = kb.entries.find(
      (e) =>
        e.category === "verification_lesson" &&
        (e.content as Record<string, unknown>).description === desc &&
        (e.content as Record<string, unknown>).fixApplied === fix
    );
    if (existing) {
      existing.times_applied += 1;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.updated_at = new Date().toISOString();
      await saveKnowledgeBase(kb);
      return;
    }
  }

  kb.entries.push(entry);
  await saveKnowledgeBase(kb);
}

export async function queryByTags(tags: string[]): Promise<KnowledgeEntry[]> {
  const kb = await loadKnowledgeBase();
  return kb.entries.filter((entry) =>
    tags.some((tag) => entry.tags.includes(tag))
  );
}

export async function queryByCategory(category: string): Promise<KnowledgeEntry[]> {
  const kb = await loadKnowledgeBase();
  return kb.entries.filter((entry) => entry.category === category);
}
