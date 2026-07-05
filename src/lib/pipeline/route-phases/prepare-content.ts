/**
 * Phase: PREPARE CONTENT (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: A-roll transcription loop (incl. alignTranscription), narrative
 * ordering, offset-merge, B-roll scene analysis, speech keywords, narrative
 * context.
 */

import path from "path";
import fs from "fs";

import { getVideoMetadata } from "@/lib/analysis/frameExtractor";
import { withCache } from "@/lib/analysis/analysisCache";
import { orderArollClipsByNarrative } from "@/lib/analysis/aroll-narrative-orderer";

// Gemini
import { geminiFlash } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";

// Pipeline modules
import { alignTranscription } from "@/lib/pipeline/aligner";
import {
  analyzeNarrativeContext,
  extractSpeechKeywords,
  buildArollSummaries,
  buildBrollSummaries,
} from "@/lib/pipeline/narrative-analyzer";

import type { PipelineCtx } from "./types";
import { withRetry } from "./utils";

// ════════════════════════════════════════════════════════════
// A-ROLL TRANSCRIPTION — Independent from reference
// ════════════════════════════════════════════════════════════

/**
 * Transcribe the A-roll video to get accurate word-level timestamps.
 *
 * The reference video's transcription has DIFFERENT timing because it was
 * edited (with B-roll overlays). The A-roll is the raw footage, so we
 * must transcribe it independently to get correct sentence boundaries
 * for layout transitions.
 */
async function transcribeAroll(
  videoPath: string
): Promise<{ words: Array<{ word: string; start: number; end: number }>; sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }> }> {
  return withCache(videoPath, "aroll_transcription", async () => {
    console.log("[clone-style] Transcribing A-roll independently for accurate sentence boundaries...");

    const mimeType = videoPath.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
    const geminiFile = await uploadToGemini(videoPath, mimeType, path.basename(videoPath));
    const processedFile = await waitForFileProcessing(geminiFile.name);

    const fileData = {
      fileData: {
        mimeType: processedFile.mimeType,
        fileUri: processedFile.uri,
      },
    };

    const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this video's audio with EXACT word-level timestamps.

CRITICAL INSTRUCTIONS:
- Provide timestamps for EVERY word
- Timestamps must be in SECONDS (decimal, e.g., 2.35)
- Start time = when the word begins being spoken
- End time = when the word finishes being spoken
- Be as precise as possible — even 0.1s matters for video editing
- Group words into sentences (a sentence ends with a period, question mark, or exclamation mark)
- For each sentence, assign semantic_tags that describe the content topic (e.g., ["intro", "hook"], ["product_demo"], ["call_to_action"])

Return JSON in this EXACT format:
{
  "words": [
    { "word": "example", "start": 0.0, "end": 0.5 },
    ...
  ],
  "sentences": [
    { "text": "Full sentence text.", "start": 0.0, "end": 3.5, "semantic_tags": ["intro", "hook"] },
    ...
  ]
}

Return ONLY the JSON, no markdown fences, no explanation.`;

    const result = await withRetry(() =>
      geminiFlash.generateContent([{ text: prompt }, fileData])
    );
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const data = JSON.parse(cleaned);

    console.log(`[clone-style] A-roll transcription: ${data.words?.length ?? 0} words, ${data.sentences?.length ?? 0} sentences`);
    for (const s of (data.sentences ?? [])) {
      console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}s] "${s.text.slice(0, 60)}${s.text.length > 60 ? '...' : ''}"`);
    }

    return {
      words: data.words ?? [],
      sentences: data.sentences ?? [],
    };
  });
}

export async function prepareContent(ctx: PipelineCtx): Promise<void> {
  const { arollPaths, brollPaths, tempDir, sendSSE } = ctx;
  const blueprint = ctx.blueprint!;

  // ════════════════════════════════════════════
  // PHASE 3: Editing Plan
  // ════════════════════════════════════════════
  sendSSE({ phase: "building_plan", progress: 48, message: `Transcribing A-roll (${arollPaths.length} clip${arollPaths.length > 1 ? 's' : ''})...` });

  // ── Multi-A-roll transcription ──
  // Two passes when >1 clip is uploaded:
  //   (1) Transcribe each clip independently (clip-local timestamps).
  //   (2) Ask Gemini to choose the narrative order, then apply it before
  //       cumulative-offset stitching. Upload order is rarely narrative
  //       order — creators shoot out of sequence. Reordering here means
  //       the renderer's -i input order, the merged transcription, and
  //       all downstream sentence→clip mapping naturally follow the
  //       coherent story without changing anything downstream.
  //   For single A-roll: trivial path, no Gemini call.

  // Pass 1: per-clip transcription + duration probe, keyed by upload index.
  const rawClips: Array<{
    uploadIndex: number;
    path: string;
    duration: number;
    words: Array<{ word: string; start: number; end: number }>;
    sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
  }> = [];
  for (let ai = 0; ai < arollPaths.length; ai++) {
    const clipPath = arollPaths[ai];
    const clipTranscription = await transcribeAroll(clipPath);
    const clipMeta = await getVideoMetadata(clipPath);
    // Forced alignment: keep Gemini's WORDS but re-pin their TIMES to the actual audio
    // (Gemini times drift 0.5–2.2s). Uses the COMMERCIAL-SAFE aligner (stable-ts/Whisper,
    // MIT, by default; MMS is non-commercial dev-only). Per clip BEFORE the offset-merge,
    // so the whole timeline (plan, MG placement, captions) is aligned. Non-blocking.
    const aligned = alignTranscription(clipTranscription, clipPath, tempDir, ai);
    rawClips.push({
      uploadIndex: ai,
      path: clipPath,
      duration: clipMeta.duration,
      words: aligned.words,
      sentences: aligned.sentences,
    });
  }

  // Pass 2a: decide narrative order (no-op for single clip).
  let narrativeOrder: number[] = rawClips.map((_, i) => i);
  let narrativeReason = "single clip — upload order kept";
  if (rawClips.length > 1) {
    sendSSE({
      phase: "building_plan",
      progress: 49,
      message: `Ordering ${rawClips.length} A-roll clips by narrative...`,
    });
    const result = await orderArollClipsByNarrative(
      rawClips.map((c) => ({
        uploadIndex: c.uploadIndex,
        text: c.sentences.map((s) => s.text).join(" "),
      }))
    );
    narrativeOrder = result.order;
    narrativeReason = result.reasoning;
    console.log(
      `[clone-style] A-roll narrative order: [${narrativeOrder.join(", ")}] ` +
        `(upload order was [${rawClips.map((_, i) => i).join(", ")}]) — ${narrativeReason}`
    );
  }

  // Pass 2b: replay clips in narrative order, applying cumulative offsets.
  const allArollTranscriptions: Array<{
    words: Array<{ word: string; start: number; end: number }>;
    sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
  }> = [];
  const arollClipMeta: Array<{ path: string; duration: number; timelineStart: number }> = [];
  const orderedArollPaths: string[] = [];
  let cumulativeOffset = 0;
  for (let pos = 0; pos < narrativeOrder.length; pos++) {
    const ai = narrativeOrder[pos];
    const c = rawClips[ai];
    const offsetWords = c.words.map((w) => ({
      ...w,
      start: w.start + cumulativeOffset,
      end: w.end + cumulativeOffset,
    }));
    const offsetSentences = c.sentences.map((s) => ({
      ...s,
      start: s.start + cumulativeOffset,
      end: s.end + cumulativeOffset,
    }));
    allArollTranscriptions.push({
      words: offsetWords,
      sentences: offsetSentences,
    });
    arollClipMeta.push({
      path: c.path,
      duration: c.duration,
      timelineStart: cumulativeOffset,
    });
    orderedArollPaths.push(c.path);
    if (rawClips.length > 1) {
      console.log(
        `[clone-style] A-roll pos #${pos + 1} = upload#${ai + 1}: ` +
          `offset=${cumulativeOffset.toFixed(2)}s, duration=${c.duration.toFixed(2)}s, ` +
          `${offsetSentences.length} sentences`
      );
    }
    cumulativeOffset += c.duration;
  }

  // The renderer reads `arollClipMeta` (now in narrative order) so its -i
  // inputs match. Replace upload-order arollPaths with narrative-order for
  // any downstream code that still consumes the bare path list.
  arollPaths.length = 0;
  arollPaths.push(...orderedArollPaths);

  // Merge all transcriptions into one continuous timeline
  const mergedTranscription = {
    words: allArollTranscriptions.flatMap((t) => t.words),
    sentences: allArollTranscriptions.flatMap((t) => t.sentences),
  };

  // Save merged transcription for debugging
  fs.writeFileSync(
    path.join(tempDir, "aroll-transcription.json"),
    JSON.stringify({
      clipCount: arollPaths.length,
      clips: arollClipMeta,
      ...mergedTranscription,
    }, null, 2)
  );

  sendSSE({ phase: "building_plan", progress: 50, message: "Analyzing content relationships..." });

  // ── Multi-B-roll scene extraction ──
  // Collect scenes from ALL B-roll sources with source index tracking
  const allBrollScenes: Array<{
    start: number; end: number; contentTags: string[]; description: string;
    sourceIndex: number; visibleText?: string[]; uiElements?: string[];
    frameContent?: Array<{ timestamp: number; visibleText?: string[]; contentTags: string[] }>;
  }> = [];
  const brollClipMeta: Array<{ path: string; duration: number; inputIndex: number }> = [];

  const brollData = blueprint.broll ?? [];
  for (let bi = 0; bi < brollPaths.length; bi++) {
    const brollAnalysis = brollData[bi];
    const brollMeta = brollAnalysis
      ? { duration: brollAnalysis.duration }
      : await getVideoMetadata(brollPaths[bi]);

    brollClipMeta.push({
      path: brollPaths[bi],
      duration: brollMeta.duration,
      inputIndex: bi,
    });

    const scenes = brollAnalysis?.internalScenes ?? [];
    // Get per-frame content for trimming (Improvement #2)
    const allFrameContent = (brollAnalysis as any)?.frameContent ?? [];

    for (const scene of scenes) {
      const sceneStart = (scene as { start: number }).start;
      const sceneEnd = (scene as { end: number }).end;

      // Filter frame content to this scene's time range
      const sceneFrameContent = allFrameContent
        .filter((f: any) => f.timestamp >= sceneStart && f.timestamp <= sceneEnd)
        .map((f: any) => ({
          timestamp: f.timestamp as number,
          visibleText: f.visibleText as string[] | undefined,
          contentTags: (f.contentTags ?? []) as string[],
        }));

      allBrollScenes.push({
        start: sceneStart,
        end: sceneEnd,
        contentTags: (scene as { contentTags: string[] }).contentTags ?? [],
        description: (scene as { description: string }).description ?? "",
        sourceIndex: bi,
        visibleText: (scene as any).visibleText ?? [],
        uiElements: (scene as any).uiElements ?? [],
        frameContent: sceneFrameContent.length > 0 ? sceneFrameContent : undefined,
      });
    }
  }

  const totalBrollDuration = brollClipMeta.reduce((sum, m) => sum + m.duration, 0);

  // ── Deep content awareness pipeline ──
  // 3 Gemini calls: (1) keyword extraction, (2) narrative analysis, (3) verification
  let narrativeContext;
  let speechKeywords;

  if (allBrollScenes.length > 0 && mergedTranscription.sentences.length > 0) {
    try {
      // #4: Extract specific keywords from each sentence
      sendSSE({ phase: "building_plan", progress: 51, message: "Extracting speech keywords..." });
      speechKeywords = await extractSpeechKeywords(
        mergedTranscription.sentences.map((s, i) => ({ index: i, text: s.text }))
      );
      fs.writeFileSync(
        path.join(tempDir, "speech-keywords.json"),
        JSON.stringify(speechKeywords, null, 2)
      );

      // #1 + #5: Full narrative analysis with OCR text and phase alignment
      sendSSE({ phase: "building_plan", progress: 52, message: "Analyzing narrative context..." });
      const arollSummaries = buildArollSummaries(allArollTranscriptions);
      const brollSummaries = buildBrollSummaries(
        brollData.length > 0
          ? brollData.map((b: any) => ({
              internalScenes: (b.internalScenes ?? []).map((s: any) => ({
                ...s,
                visibleText: s.visibleText ?? [],
                uiElements: s.uiElements ?? [],
              })),
            }))
          : [{ internalScenes: allBrollScenes.map(s => ({
              ...s,
              visibleText: (s as any).visibleText ?? [],
              uiElements: (s as any).uiElements ?? [],
            })) }]
      );

      narrativeContext = await analyzeNarrativeContext(
        arollSummaries.summaries,
        brollSummaries,
        speechKeywords
      );

      // Save narrative context for debugging
      fs.writeFileSync(
        path.join(tempDir, "narrative-context.json"),
        JSON.stringify(narrativeContext, null, 2)
      );
    } catch (err) {
      console.error("[clone-style] Content awareness pipeline failed, falling back to tag matching:", err);
    }
  }

  // ── Write phase outputs back to the shared ctx ──
  ctx.allArollTranscriptions = allArollTranscriptions;
  ctx.arollClipMeta = arollClipMeta;
  ctx.mergedTranscription = mergedTranscription;
  ctx.allBrollScenes = allBrollScenes;
  ctx.brollClipMeta = brollClipMeta;
  ctx.totalBrollDuration = totalBrollDuration;
  ctx.narrativeContext = narrativeContext;
  ctx.speechKeywords = speechKeywords;
}
