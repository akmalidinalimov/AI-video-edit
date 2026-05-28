import { NextRequest } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { REFERENCE_PASS1_PROMPT } from "@/lib/gemini/prompts/referencePass1";
import { getReferencePass2Prompt } from "@/lib/gemini/prompts/referencePass2";
import { REFERENCE_PASS3_PROMPT } from "@/lib/gemini/prompts/referencePass3";
import { REFERENCE_PASS4_PROMPT } from "@/lib/gemini/prompts/referencePass4";
import { Pass1Schema, Pass2Schema, Pass3Schema, Pass4Schema } from "@/lib/gemini/schemas/styleProfile";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function sendEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
}

async function runWithFallback(
  prompt: string | { text: string },
  fileData: { fileData: { mimeType: string; fileUri: string } },
  schema: { safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  passName: string
) {
  const textPart = typeof prompt === "string" ? { text: prompt } : prompt;

  try {
    const result = await geminiFlash.generateContent([textPart, fileData]);
    const text = result.response.text();
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn(`${passName}: Flash returned invalid schema, falling back to Pro`);
  } catch (err) {
    console.warn(`${passName}: Flash failed (${err instanceof Error ? err.message : "unknown"}), falling back to Pro`);
  }

  const result = await geminiPro.generateContent([textPart, fileData]);
  const text = result.response.text();
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${passName}: Both Flash and Pro returned invalid data`);
  }
  return parsed.data;
}

export async function POST(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const formData = await request.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
          sendEvent(controller, "error", { message: "No file provided" });
          controller.close();
          return;
        }

        sendEvent(controller, "status", { step: "upload", message: "Saving file..." });

        const uploadsDir = join(process.cwd(), "public", "uploads");
        await mkdir(uploadsDir, { recursive: true });

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);
        const filePath = join(uploadsDir, file.name);
        await writeFile(filePath, buffer);

        sendEvent(controller, "status", { step: "gemini_upload", message: "Uploading to Gemini..." });

        const geminiFile = await uploadToGemini(filePath, file.type, file.name);

        sendEvent(controller, "status", { step: "processing", message: "Gemini is processing the video..." });

        const processedFile = await waitForFileProcessing(geminiFile.name);
        const fileData = {
          fileData: {
            mimeType: processedFile.mimeType,
            fileUri: processedFile.uri,
          },
        };

        // Pass 1 — Structure Scan
        sendEvent(controller, "progress", { pass: 1, total: 4, message: "Pass 1/4: Structure Scan..." });
        const pass1 = await runWithFallback(
          REFERENCE_PASS1_PROMPT,
          fileData,
          Pass1Schema,
          "Pass 1"
        );
        sendEvent(controller, "pass_complete", { pass: 1, data: pass1 });

        // Pass 2 — Visual Element Mapping
        sendEvent(controller, "progress", { pass: 2, total: 4, message: "Pass 2/4: Visual Element Mapping..." });
        const pass2 = await runWithFallback(
          getReferencePass2Prompt(JSON.stringify(pass1)),
          fileData,
          Pass2Schema,
          "Pass 2"
        );
        sendEvent(controller, "pass_complete", { pass: 2, data: pass2 });

        // Pass 3 — Audio-Visual Sync
        sendEvent(controller, "progress", { pass: 3, total: 4, message: "Pass 3/4: Audio-Visual Sync..." });
        const pass3 = await runWithFallback(
          REFERENCE_PASS3_PROMPT,
          fileData,
          Pass3Schema,
          "Pass 3"
        );
        sendEvent(controller, "pass_complete", { pass: 3, data: pass3 });

        // Pass 4 — Style Fingerprint
        sendEvent(controller, "progress", { pass: 4, total: 4, message: "Pass 4/4: Style Fingerprint..." });
        const pass4 = await runWithFallback(
          REFERENCE_PASS4_PROMPT,
          fileData,
          Pass4Schema,
          "Pass 4"
        );
        sendEvent(controller, "pass_complete", { pass: 4, data: pass4 });

        // Build final style profile
        const styleProfile = buildStyleProfile(
          pass1 as ReturnType<typeof Pass1Schema.parse>,
          pass2 as ReturnType<typeof Pass2Schema.parse>,
          pass3 as ReturnType<typeof Pass3Schema.parse>,
          pass4 as ReturnType<typeof Pass4Schema.parse>
        );

        sendEvent(controller, "complete", {
          styleProfile,
          passes: { pass1, pass2, pass3, pass4 },
          geminiFileUri: processedFile.uri,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Analysis failed";
        console.error("Reference analysis error:", error);
        sendEvent(controller, "error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function buildStyleProfile(
  pass1: ReturnType<typeof Pass1Schema.parse>,
  pass2: ReturnType<typeof Pass2Schema.parse>,
  pass3: ReturnType<typeof Pass3Schema.parse>,
  pass4: ReturnType<typeof Pass4Schema.parse>
) {
  const segments = pass1.segments.map((seg) => {
    const visual = pass2.segments.find((s) => s.id === seg.id);
    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      layout: seg.layout,
      aroll: visual?.aroll || undefined,
      broll: visual?.broll || undefined,
      text_overlays: visual?.text_overlays || [],
      other_elements: visual?.other_elements || [],
      transition_in: seg.transition_in,
      transition_out: "none",
      description: seg.description,
    };
  });

  return {
    version: "2.0",
    source: {
      duration: pass1.duration,
      fps: pass1.fps,
      resolution: pass1.resolution,
    },
    segments,
    color_grade: pass4.color_grade,
    pip_style: pass4.pip_style,
    editing_rhythm: {
      ...pass1.editing_rhythm,
      cut_frequency: pass4.editing_rhythm.cut_frequency,
      transition_preference: pass4.editing_rhythm.transition_preference,
    },
    transcription: pass3.transcription,
    sync_map: pass3.sync_map,
  };
}
