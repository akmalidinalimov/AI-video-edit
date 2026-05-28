import type { StyleProfile, Segment } from "@/lib/types/styleProfile";
import type {
  TimelineDefinition, TimelineSegment, AudioTrack,
  TransitionPlan, EngagementHook, CaptionTrack,
} from "@/lib/types/timeline";
import type { ContentSegment } from "./segmenter";
import type { MatchResult, ARollClipAnalysis, BRollCatalogEntry } from "@/lib/types/project";
import { computeMotionKeyframes } from "./motionKeyframes";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

interface BuildOptions {
  transitions?: TransitionPlan[];
  hook?: EngagementHook | null;
  captions: CaptionTrack;
}

/**
 * Resolve a fileId to an accessible URL for Remotion rendering.
 * Files uploaded via /api/analyze/* are saved to public/uploads/.
 * If a custom fileUrlMap is provided, use it for lookup first.
 */
function resolveFileUrl(
  fileId: string,
  fileName: string | undefined,
  fileUrlMap?: Record<string, string>
): string {
  if (fileUrlMap) {
    if (fileUrlMap[fileId]) return fileUrlMap[fileId];
    if (fileName && fileUrlMap[fileName]) return fileUrlMap[fileName];
  }
  // Default: assume file lives in public/uploads/ under its name
  const name = fileName || fileId;
  return name ? `/uploads/${name}` : "";
}

export function buildTimeline(
  contentSegments: ContentSegment[],
  matches: MatchResult[],
  style: StyleProfile,
  clips: ARollClipAnalysis[],
  brollCatalog: BRollCatalogEntry[],
  options: BuildOptions,
  /** Optional map of fileId/fileName → URL for resolving media sources */
  fileUrlMap?: Record<string, string>
): TimelineDefinition {
  const totalDuration = contentSegments.reduce((sum, s) => sum + s.duration, 0);

  const timelineSegments: TimelineSegment[] = contentSegments.map((seg, i) => {
    const match = matches.find((m) => m.segment_id === seg.id);
    const refSegment = pickStyleSegment(style, i, contentSegments.length);
    const brollEntry = match && match.selected_broll !== "NONE"
      ? brollCatalog.find((b) => b.id === match.selected_broll)
      : null;
    const clip = clips.find((c) => c.fileId === seg.clipId);

    const startFrame = Math.round(seg.globalStart * FPS);
    const endFrame = Math.round(seg.globalEnd * FPS);

    // Smart transitions from Gemini or fallback to reference
    // IMPORTANT: If reference uses hard_cut, override ALL transitions to none
    const isHardCutRef = style.editing_rhythm.cut_style === "hard_cut";
    let transitionIn = null;
    let transitionOut = null;

    if (!isHardCutRef) {
      const transitionPlan = options.transitions?.find((t) => t.segment_id === seg.id);
      transitionIn = transitionPlan
        ? transitionPlan.transition_in
        : refSegment?.transition_in && refSegment.transition_in !== "none"
          ? { type: refSegment.transition_in, duration_frames: 8 }
          : null;
      transitionOut = i === contentSegments.length - 1
        ? { type: "fade", duration_frames: 10 }
        : null;
    }

    // B-roll motion keyframes
    const motion = brollEntry
      ? computeMotionKeyframes(brollEntry, seg.duration, startFrame)
      : undefined;

    // B-roll start time — prevents repetition when same source is reused
    // Priority: 1) Gemini match data, 2) sequential offset into source, 3) 0
    const segDuration = seg.globalEnd - seg.globalStart;
    let brollStartTime = 0;
    if (match?.broll_start !== null && match?.broll_start !== undefined) {
      brollStartTime = match.broll_start;
    } else if (brollEntry?.duration && brollEntry.duration > 0) {
      // Offset into B-roll based on segment position, wrap if needed
      brollStartTime = seg.globalStart % brollEntry.duration;
      // Ensure enough remaining duration for this segment
      if (brollStartTime + segDuration > brollEntry.duration) {
        brollStartTime = Math.max(0, brollEntry.duration - segDuration);
      }
    }

    // Derive legacy scroll/scale from motion for backward compat
    const legacyScroll = motion?.type === "scroll"
      ? {
          speed: Math.abs(motion.keyframes[1].y - motion.keyframes[0].y) / (endFrame - startFrame),
          direction: "up" as const,
          maxOffset: Math.abs(motion.keyframes[1].y),
        }
      : undefined;
    const legacyScale = motion?.type === "ken_burns"
      ? motion.keyframes[1].scale
      : undefined;

    return {
      id: seg.id,
      start_frame: startFrame,
      end_frame: endFrame,
      layout: refSegment?.layout ?? "full_screen",
      broll: {
        src: brollEntry
          ? resolveFileUrl(brollEntry.fileId, brollEntry.fileId, fileUrlMap)
          : "",
        startFrom: brollStartTime,
        position: buildBrollPosition(refSegment),
        size: buildBrollSize(refSegment),
        crop: brollEntry?.crop_recommendation?.crop ?? undefined,
        scroll: refSegment?.broll?.scroll
          ? {
              speed: refSegment.broll.scroll.speed,
              direction: refSegment.broll.scroll.direction === "up" || refSegment.broll.scroll.direction === "down"
                ? refSegment.broll.scroll.direction
                : "up",
              maxOffset: refSegment.broll.scroll.max_offset,
            }
          : legacyScroll,
        scale: legacyScale,
        motion,
      },
      aroll: clip?.analysis.speaker
        ? {
            src: resolveFileUrl(clip.fileId, clip.fileName, fileUrlMap),
            startFrom: seg.start,
            position: buildArollPosition(style, refSegment),
            size: resolveArollSize(style, refSegment),
            shape: refSegment?.aroll?.shape ?? style.pip_style.shape,
            border: refSegment?.aroll?.border ?? style.pip_style.border,
            shadow: style.pip_style.shadow,
          }
        : undefined,
      text_overlays: buildTextOverlays(refSegment, seg, startFrame, endFrame),
      transition_in: transitionIn ? { type: transitionIn.type ?? transitionIn as unknown as string, duration_frames: (transitionIn as { duration_frames?: number }).duration_frames ?? 8 } : undefined,
      transition_out: transitionOut ?? undefined,
    };
  });

  // Audio is handled by the A-roll video itself (not a separate mixer)
  return {
    id: `timeline_${Date.now()}`,
    duration: totalDuration,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    segments: timelineSegments,
    audio: [],
    captions: options.captions,
    hook: options.hook ?? null,
    color_grade: style.color_grade,
  };
}

function pickStyleSegment(
  style: StyleProfile,
  index: number,
  totalSegments: number
): Segment | null {
  if (style.segments.length === 0) return null;
  const ratio = index / Math.max(totalSegments - 1, 1);
  const refIndex = Math.min(
    Math.round(ratio * (style.segments.length - 1)),
    style.segments.length - 1
  );
  return style.segments[refIndex];
}

function buildArollPosition(
  style: StyleProfile,
  refSegment: Segment | null
): [number, number] {
  if (refSegment?.aroll?.position) return refSegment.aroll.position;
  if (style.pip_style.preferred_positions?.length) return style.pip_style.preferred_positions[0];
  return [WIDTH - 200, HEIGHT - 200];
}

function resolveArollSize(
  style: StyleProfile,
  refSegment: Segment | null
): [number, number] {
  // Per-segment size from reference takes priority
  if (refSegment?.aroll?.size) {
    const s = refSegment.aroll.size;
    if (Array.isArray(s) && s.length >= 2) return [s[0], s[1]];
    if (typeof s === "number") return [s, s];
  }
  // Fallback to global pip_style
  const fallback = style.pip_style.typical_size ?? style.pip_style.size ?? 280;
  return [fallback, fallback];
}

function buildBrollPosition(
  refSegment: Segment | null
): [number, number] {
  if (refSegment?.broll?.position) return refSegment.broll.position;
  // Default: full-screen (top-left corner)
  return [0, 0];
}

function buildBrollSize(
  refSegment: Segment | null
): [number, number] {
  if (refSegment?.broll?.size) return refSegment.broll.size;
  // Default: full-screen
  return [WIDTH, HEIGHT];
}

function buildTextOverlays(
  refSegment: Segment | null,
  contentSeg: ContentSegment,
  startFrame: number,
  endFrame: number
): TimelineSegment["text_overlays"] {
  if (!refSegment?.text_overlays?.length) return [];

  // Use content segment text; if empty, fall back to reference overlay's original text
  const displayText = contentSeg.text.trim()
    ? (contentSeg.text.length > 60 ? contentSeg.text.slice(0, 57) + "..." : contentSeg.text)
    : null;

  return refSegment.text_overlays
    .map((overlay) => {
      // Use content text, or fall back to the reference text (branding/labels)
      const text = displayText ?? overlay.text ?? "";
      if (!text) return null; // Skip completely empty overlays

      return {
        text,
        position: overlay.position,
        style: { ...overlay.style },
        animation: overlay.animation ? { ...overlay.animation } : undefined,
        start_frame: startFrame + (overlay.animation?.start_offset ? Math.round(overlay.animation.start_offset * FPS) : 0),
        end_frame: endFrame,
      };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null);
}

function buildAudioTracks(
  segments: ContentSegment[],
  clips: ARollClipAnalysis[],
  fileUrlMap?: Record<string, string>
): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  const clipGroups = new Map<string, ContentSegment[]>();

  for (const seg of segments) {
    const group = clipGroups.get(seg.clipId) ?? [];
    group.push(seg);
    clipGroups.set(seg.clipId, group);
  }

  for (const [clipId, segs] of clipGroups) {
    const clip = clips.find((c) => c.fileId === clipId);
    const volume = clip?.analysis.audio_quality
      ? normalizeVolume(clip.analysis.audio_quality.estimated_db)
      : 1.0;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const startFrame = Math.round(seg.globalStart * FPS);
      const endFrame = Math.round(seg.globalEnd * FPS);

      // Crossfade: fade in on first segment of a clip, fade out on last
      const isFirstOfClip = i === 0;
      const isLastOfClip = i === segs.length - 1;

      tracks.push({
        src: resolveFileUrl(clipId, clip?.fileName, fileUrlMap),
        type: "aroll_voice",
        volume,
        start_frame: startFrame,
        end_frame: endFrame,
        sourceStartFrom: Math.round(seg.start * FPS),
        fade_in: isFirstOfClip ? 3 : undefined,
        fade_out: isLastOfClip ? 4 : undefined,
      });
    }
  }

  return tracks;
}

function normalizeVolume(estimatedDb: number): number {
  const targetDb = -14;
  const diff = targetDb - estimatedDb;
  const gain = Math.pow(10, diff / 20);
  return Math.max(0.3, Math.min(2.0, gain));
}
