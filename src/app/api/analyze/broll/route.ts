import { NextRequest, NextResponse } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { BROLL_CATALOG_PROMPT } from "@/lib/gemini/prompts/brollCatalog";
import { BRollCatalogSchema } from "@/lib/gemini/schemas/brollCatalog";
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

    let catalog;
    try {
      const result = await geminiFlash.generateContent([
        { text: BROLL_CATALOG_PROMPT },
        fileData,
      ]);
      const parsed = BRollCatalogSchema.safeParse(JSON.parse(result.response.text()));
      if (parsed.success) {
        catalog = parsed.data;
      } else {
        throw new Error("Flash returned invalid schema");
      }
    } catch {
      console.warn(`B-roll (${file.name}): Flash failed, falling back to Pro`);
      const result = await geminiPro.generateContent([
        { text: BROLL_CATALOG_PROMPT },
        fileData,
      ]);
      const parsed = BRollCatalogSchema.safeParse(JSON.parse(result.response.text()));
      if (!parsed.success) {
        return NextResponse.json(
          { error: `Could not analyze ${file.name}. The AI returned an unexpected format.` },
          { status: 422 }
        );
      }
      catalog = parsed.data;
    }

    return NextResponse.json({
      entry: {
        id: `broll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fileId: file.name,
        fileName: file.name,
        geminiFileUri: processedFile.uri,
        ...catalog,
      },
    });
  } catch (error) {
    console.error("B-roll analysis error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `B-roll analysis failed: ${message}. Please try again.` },
      { status: 500 }
    );
  }
}
