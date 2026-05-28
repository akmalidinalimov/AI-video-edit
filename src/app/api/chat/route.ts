import { NextRequest, NextResponse } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { buildEditCommandPrompt } from "@/lib/gemini/prompts/editCommand";
import { executeCommands } from "@/lib/editing/commandExecutor";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { EditCommand } from "@/lib/types/editCommand";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

interface ChatRequest {
  message: string;
  timeline: TimelineDefinition;
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequest = await request.json();
    const { message, timeline } = body;

    if (!message?.trim()) {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }
    if (!timeline) {
      return NextResponse.json({ error: "Timeline required" }, { status: 400 });
    }

    // Build prompt and call Gemini
    const prompt = buildEditCommandPrompt(message, timeline);

    let parsed: { commands: EditCommand[]; reply: string } | null = null;

    // Try Flash first, then Pro
    try {
      const response = await geminiFlash.generateContent([{ text: prompt }]);
      const text = response.response.text().trim();
      // Strip markdown code fences if present
      const jsonStr = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      parsed = JSON.parse(jsonStr);
    } catch {
      console.warn("Flash failed for chat, trying Pro");
      try {
        const response = await geminiPro.generateContent([{ text: prompt }]);
        const text = response.response.text().trim();
        const jsonStr = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        console.error("Pro also failed:", e);
      }
    }

    if (!parsed) {
      return NextResponse.json({
        reply: "I couldn't understand that edit request. Try something like \"make captions bigger\" or \"change layout to PIP overlay\".",
        commands: [],
        timeline: null,
        editResult: null,
      });
    }

    // Execute commands if any
    if (parsed.commands.length > 0) {
      const result = executeCommands(timeline, parsed.commands);
      return NextResponse.json({
        reply: parsed.reply,
        commands: parsed.commands,
        timeline: result.timeline,
        editResult: {
          applied: result.appliedCommands.length,
          failed: result.failedCommands.length,
          summary: result.summary,
          failedDetails: result.failedCommands,
        },
      });
    }

    return NextResponse.json({
      reply: parsed.reply,
      commands: [],
      timeline: null,
      editResult: null,
    });
  } catch (error) {
    console.error("Chat error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Chat failed: ${message}` },
      { status: 500 }
    );
  }
}
