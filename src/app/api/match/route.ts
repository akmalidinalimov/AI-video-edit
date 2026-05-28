import { NextRequest, NextResponse } from "next/server";
import { geminiFlash, geminiPro } from "@/lib/gemini/client";
import { buildMatchingPrompt } from "@/lib/gemini/prompts/brollMatching";
import { BRollMatchingSchema } from "@/lib/gemini/schemas/brollMatching";
import { buildEditIntelligencePrompt } from "@/lib/gemini/prompts/editIntelligence";
import { EditIntelligenceSchema } from "@/lib/gemini/schemas/editIntelligence";
import { segmentContent } from "@/lib/matching/segmenter";
import { buildTimeline } from "@/lib/matching/timelineBuilder";
import { generateCaptions } from "@/lib/matching/captionGenerator";
import { optimizeMatches } from "@/lib/matching/matchOptimizer";
import { generateRenderDescriptions } from "@/lib/matching/renderDescriptions";
import { runVerificationLoop } from "@/lib/verification/verificationLoop";
import { addEntry } from "@/lib/knowledge/store";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { ARollClipAnalysis, ARollSequence, BRollCatalogEntry, MatchResult } from "@/lib/types/project";
import type { TransitionPlan, EngagementHook, MissingAssetPrompt } from "@/lib/types/timeline";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

interface MatchRequest {
  styleProfile: StyleProfile;
  arollAnalyses: ARollClipAnalysis[];
  arollSequence: ARollSequence | null;
  brollCatalog: BRollCatalogEntry[];
}

async function runWithFallback<T>(
  prompt: string,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } }
): Promise<T | null> {
  try {
    const response = await geminiFlash.generateContent([{ text: prompt }]);
    const parsed = schema.safeParse(JSON.parse(response.response.text()));
    if (parsed.success) return parsed.data!;
    throw new Error("Flash schema mismatch");
  } catch {
    console.warn("Flash failed, falling back to Pro");
    try {
      const response = await geminiPro.generateContent([{ text: prompt }]);
      const parsed = schema.safeParse(JSON.parse(response.response.text()));
      if (parsed.success) return parsed.data!;
    } catch (e) {
      console.error("Pro also failed:", e);
    }
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: MatchRequest = await request.json();
    const { styleProfile, arollAnalyses, arollSequence, brollCatalog } = body;

    if (!styleProfile || arollAnalyses.length === 0) {
      return NextResponse.json(
        { error: "Style profile and at least one A-roll analysis required" },
        { status: 400 }
      );
    }

    // Step 1: Segment the content
    console.log(`[Match API] A-roll clips:`, arollAnalyses.map(c => ({
      fileId: c.fileId,
      duration: c.analysis.duration,
      hasUsableSegments: !!c.usableSegments,
      usableCount: c.usableSegments?.length ?? 'none (full video)',
    })));

    const contentSegments = segmentContent(arollAnalyses, arollSequence, styleProfile);

    console.log(`[Match API] Content segments:`, contentSegments.map(s => ({
      id: s.id, start: s.start.toFixed(2), end: s.end.toFixed(2),
      globalStart: s.globalStart.toFixed(2), globalEnd: s.globalEnd.toFixed(2),
      duration: s.duration.toFixed(2),
    })));

    if (contentSegments.length === 0) {
      return NextResponse.json(
        { error: "Could not create content segments from A-roll" },
        { status: 422 }
      );
    }

    // Step 2: Match B-roll to segments via Gemini
    let matches: MatchResult[];

    if (brollCatalog.length === 0) {
      matches = contentSegments.map((seg) => ({
        segment_id: seg.id,
        segment_start: seg.globalStart,
        segment_end: seg.globalEnd,
        speech_text: seg.text,
        selected_broll: "NONE",
        match_reason: "No B-roll assets available",
        match_score: 0,
        broll_start: null,
        broll_end: null,
        alternative_brolls: [],
      }));
    } else {
      const matchPrompt = buildMatchingPrompt(contentSegments, brollCatalog);
      const matchResult = await runWithFallback(matchPrompt, BRollMatchingSchema);

      if (!matchResult) {
        return NextResponse.json(
          { error: "Could not match B-roll to segments. Please try again." },
          { status: 422 }
        );
      }

      matches = matchResult.matches.map((m) => {
        const seg = contentSegments.find((s) => s.id === m.segment_id);
        return {
          segment_id: m.segment_id,
          segment_start: seg?.globalStart ?? 0,
          segment_end: seg?.globalEnd ?? 0,
          speech_text: seg?.text ?? "",
          selected_broll: m.selected_broll,
          match_reason: m.match_reason,
          match_score: m.match_score,
          broll_start: m.broll_start,
          broll_end: m.broll_end,
          alternative_brolls: m.alternative_brolls,
        };
      });
    }

    // Step 2.5: Optimize matches — prevent repetition, redistribute overuse, boost weak
    const { matches: optimizedMatches, changes: optimizerChanges } = optimizeMatches(matches, brollCatalog);
    matches = optimizedMatches;

    // Step 3: Edit intelligence — transitions, hook, missing asset prompts
    const refTransitions = styleProfile.segments
      .map((s) => s.transition_in)
      .filter((t) => t && t !== "none") as string[];

    const editPrompt = buildEditIntelligencePrompt(
      contentSegments,
      matches,
      [...new Set(refTransitions)],
      styleProfile.color_grade.temperature
    );
    const editIntel = await runWithFallback(editPrompt, EditIntelligenceSchema);

    // Build transitions
    const transitions: TransitionPlan[] = editIntel?.transitions.map((t) => ({
      segment_id: t.segment_id,
      transition_in: { type: t.transition_in, duration_frames: t.transition_duration_frames },
      transition_out: null,
      reasoning: t.reasoning,
    })) ?? [];

    // Build hook
    const hook: EngagementHook | null = editIntel?.hook
      ? {
          type: editIntel.hook.type,
          text: editIntel.hook.text,
          duration_frames: 45,
          position: [540, 960],
          style: {
            fontSize: 56,
            fontWeight: "bold",
            color: "#FFFFFF",
            textAlign: "center",
          },
          animation: {
            type: editIntel.hook.animation,
            duration_frames: 15,
          },
        }
      : null;

    // Missing asset prompts
    const missingAssetPrompts: MissingAssetPrompt[] = editIntel?.missing_asset_prompts.map((p) => {
      const seg = contentSegments.find((s) => s.id === p.segment_id);
      return {
        segment_id: p.segment_id,
        speech_text: seg?.text ?? "",
        imagen_prompt: p.imagen_prompt,
        style_guidance: p.style_guidance,
        aspect_ratio: "9:16",
        suggested_type: p.suggested_type,
      };
    }) ?? [];

    // Step 4: Generate caption track
    const captions = generateCaptions(contentSegments, arollAnalyses, styleProfile);

    // Step 5: Build file URL map so Remotion can find the media files
    // Uploaded files are saved to public/uploads/{filename} by the analyze APIs
    const fileUrlMap: Record<string, string> = {};
    for (const clip of arollAnalyses) {
      fileUrlMap[clip.fileId] = `/uploads/${clip.fileName}`;
      fileUrlMap[clip.fileName] = `/uploads/${clip.fileName}`;
    }
    for (const broll of brollCatalog) {
      fileUrlMap[broll.fileId] = `/uploads/${broll.fileId}`;
    }

    // Build timeline with all intelligence
    const rawTimeline = buildTimeline(
      contentSegments,
      matches,
      styleProfile,
      arollAnalyses,
      brollCatalog,
      { transitions, hook, captions },
      fileUrlMap
    );

    // Step 6: Closed-loop verification — verify + auto-fix until 95% match
    console.log("[Match API] Running closed-loop verification...");
    const verificationResult = runVerificationLoop(
      rawTimeline,
      styleProfile,
      arollAnalyses,
      brollCatalog
    );

    // Use the verified (and potentially fixed) timeline
    const timeline = verificationResult.timeline;

    console.log(
      `[Match API] Verification complete: ${verificationResult.finalScore}/100` +
      ` (${verificationResult.iterations} iterations, ${verificationResult.allFixesApplied.length} fixes)`
    );

    // Step 7: Save verification lessons to knowledge base
    if (verificationResult.lessons.length > 0) {
      try {
        for (const lesson of verificationResult.lessons) {
          await addEntry({
            id: `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            category: "verification_lesson",
            content: {
              description: lesson.description,
              fixApplied: lesson.fixApplied,
              scoreImprovement: lesson.scoreImprovement,
              category: lesson.category,
            },
            confidence: Math.min(1, lesson.scoreImprovement / 10),
            times_applied: 1,
            tags: lesson.tags,
            created_at: new Date().toISOString(),
          });
        }
        console.log(`[Match API] Saved ${verificationResult.lessons.length} lessons to knowledge base`);
      } catch (err) {
        console.warn("[Match API] Failed to save lessons:", err);
      }
    }

    // Step 8: Generate render descriptions
    const renderDescriptions = generateRenderDescriptions(
      contentSegments, timeline.segments, matches, brollCatalog
    );

    return NextResponse.json({
      contentSegments,
      matches,
      timeline,
      missingAssetPrompts,
      hook,
      transitions,
      renderDescriptions,
      optimizerChanges,
      captionCount: captions.lines.length,
      verification: {
        score: verificationResult.finalScore,
        passed: verificationResult.passed,
        iterations: verificationResult.iterations,
        fixesApplied: verificationResult.allFixesApplied,
        scoreHistory: verificationResult.scoreHistory,
        dimensions: verificationResult.reports[verificationResult.reports.length - 1]?.dimensions.map((d) => ({
          name: d.name,
          score: d.scored,
          max: d.maxPoints,
        })),
      },
      stats: {
        totalSegments: contentSegments.length,
        matchedSegments: matches.filter((m) => m.selected_broll !== "NONE").length,
        unmatchedSegments: matches.filter((m) => m.selected_broll === "NONE").length,
        totalDuration: timeline.duration,
        avgMatchScore: matches.length > 0
          ? matches.reduce((sum, m) => sum + m.match_score, 0) / matches.length
          : 0,
        captionLines: captions.lines.length,
        hasHook: !!hook,
        missingAssets: missingAssetPrompts.length,
      },
    });
  } catch (error) {
    console.error("Matching error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Content matching failed: ${message}. Please try again.` },
      { status: 500 }
    );
  }
}
