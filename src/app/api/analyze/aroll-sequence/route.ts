import { NextRequest, NextResponse } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { buildSequencingPrompt } from "@/lib/gemini/prompts/arollSequencing";
import { ARollSequencingSchema } from "@/lib/gemini/schemas/arollSequencing";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface ClipInput {
  id: string;
  fileName: string;
  summary: string;
  transcription: string;
  duration: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const clips: ClipInput[] = body.clips;

    if (!clips || clips.length < 2) {
      return NextResponse.json(
        { error: "Need at least 2 clips to sequence" },
        { status: 400 }
      );
    }

    const prompt = buildSequencingPrompt(clips);

    let result;
    try {
      const response = await geminiFlash.generateContent([{ text: prompt }]);
      const parsed = ARollSequencingSchema.safeParse(
        JSON.parse(response.response.text())
      );
      if (parsed.success) {
        result = parsed.data;
      } else {
        throw new Error("Flash returned invalid schema");
      }
    } catch {
      console.warn("A-roll sequencing: Flash failed, falling back to Pro");
      const response = await geminiPro.generateContent([{ text: prompt }]);
      const parsed = ARollSequencingSchema.safeParse(
        JSON.parse(response.response.text())
      );
      if (!parsed.success) {
        return NextResponse.json(
          {
            error:
              "Could not determine clip sequence. The AI returned an unexpected format. Please try again.",
          },
          { status: 422 }
        );
      }
      result = parsed.data;
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("A-roll sequencing error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Sequencing failed: ${message}. Please try again.` },
      { status: 500 }
    );
  }
}
