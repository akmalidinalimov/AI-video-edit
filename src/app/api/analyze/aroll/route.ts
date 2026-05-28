import { NextRequest, NextResponse } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { AROLL_ANALYSIS_PROMPT } from "@/lib/gemini/prompts/arollAnalysis";
import { ARollAnalysisSchema } from "@/lib/gemini/schemas/arollProfile";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const uploadsDir = join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const filePath = join(uploadsDir, file.name);
    await writeFile(filePath, buffer);

    const geminiFile = await uploadToGemini(filePath, file.type, file.name);
    const processedFile = await waitForFileProcessing(geminiFile.name);

    const fileData = {
      fileData: {
        mimeType: processedFile.mimeType,
        fileUri: processedFile.uri,
      },
    };

    // Try Flash first, fall back to Pro
    let analysis;
    try {
      const result = await geminiFlash.generateContent([
        { text: AROLL_ANALYSIS_PROMPT },
        fileData,
      ]);
      const parsed = ARollAnalysisSchema.safeParse(JSON.parse(result.response.text()));
      if (parsed.success) {
        analysis = parsed.data;
      } else {
        throw new Error("Flash returned invalid schema");
      }
    } catch {
      console.warn("A-roll: Flash failed, falling back to Pro");
      const result = await geminiPro.generateContent([
        { text: AROLL_ANALYSIS_PROMPT },
        fileData,
      ]);
      const parsed = ARollAnalysisSchema.safeParse(JSON.parse(result.response.text()));
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Could not analyze A-roll. The AI returned an unexpected format. Please try again." },
          { status: 422 }
        );
      }
      analysis = parsed.data;
    }

    return NextResponse.json({
      analysis,
      geminiFileUri: processedFile.uri,
    });
  } catch (error) {
    console.error("A-roll analysis error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `A-roll analysis failed: ${message}. Please try uploading again.` },
      { status: 500 }
    );
  }
}
