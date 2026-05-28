import { NextRequest, NextResponse } from "next/server";
import { loadKnowledgeBase, saveKnowledgeBase, queryByTags, queryByCategory } from "@/lib/knowledge/store";
import type { KnowledgeEntry } from "@/lib/types/knowledge";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tags = searchParams.get("tags");
  const category = searchParams.get("category");

  try {
    if (tags) {
      const entries = await queryByTags(tags.split(","));
      return NextResponse.json({ entries });
    }
    if (category) {
      const entries = await queryByCategory(category);
      return NextResponse.json({ entries });
    }
    const kb = await loadKnowledgeBase();
    return NextResponse.json(kb);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load knowledge base";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const entry = (await request.json()) as KnowledgeEntry;

    if (!entry.id || !entry.category || !entry.content) {
      return NextResponse.json(
        { error: "Entry must have id, category, and content" },
        { status: 400 }
      );
    }

    const kb = await loadKnowledgeBase();
    const existing = kb.entries.findIndex((e) => e.id === entry.id);

    if (existing >= 0) {
      kb.entries[existing] = { ...kb.entries[existing], ...entry, updated_at: new Date().toISOString() };
    } else {
      kb.entries.push({ ...entry, created_at: new Date().toISOString() });
    }

    await saveKnowledgeBase(kb);
    return NextResponse.json({ success: true, entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save entry";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
