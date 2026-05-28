import type { TimelineSegment } from "@/lib/types/timeline";
import type { ContentSegment } from "./segmenter";
import type { MatchResult, BRollCatalogEntry } from "@/lib/types/project";

export interface SegmentRenderDescription {
  segmentId: string;
  description: string;
  layers: string[];
}

export function generateRenderDescriptions(
  contentSegments: ContentSegment[],
  timelineSegments: TimelineSegment[],
  matches: MatchResult[],
  brollCatalog: BRollCatalogEntry[]
): SegmentRenderDescription[] {
  return contentSegments.map((seg) => {
    const tSeg = timelineSegments.find((t) => t.id === seg.id);
    const match = matches.find((m) => m.segment_id === seg.id);
    const broll = match && match.selected_broll !== "NONE"
      ? brollCatalog.find((b) => b.id === match.selected_broll)
      : null;

    const layers: string[] = [];
    const parts: string[] = [];

    // Background layer
    if (broll) {
      const brollDesc = broll.classification === "screen_recording"
        ? `Screen recording "${broll.content_summary}" scrolling upward`
        : broll.type === "image"
          ? `Static image "${broll.content_summary}" with subtle Ken Burns zoom`
          : `Video clip "${broll.content_summary}"`;

      layers.push(`BG: ${brollDesc}`);
      parts.push(brollDesc + " fills the background");
    } else {
      layers.push("BG: Solid/gradient background (no B-roll)");
      parts.push("Solid background — missing B-roll asset");
    }

    // Layout
    if (tSeg) {
      const layoutDesc: Record<string, string> = {
        full_screen: "B-roll fills entire 1080×1920 frame",
        pip_overlay: "B-roll fills background, A-roll in circular PIP overlay",
        vertical_split: "Screen split vertically — A-roll top, B-roll bottom",
        side_by_side: "A-roll and B-roll side by side",
      };
      parts.push(layoutDesc[tSeg.layout] ?? `Layout: ${tSeg.layout}`);
    }

    // A-roll / PIP
    if (tSeg?.aroll) {
      const pos = tSeg.aroll.position;
      const shape = tSeg.aroll.shape;
      layers.push(
        `PIP: ${shape} speaker at (${pos[0]}, ${pos[1]}), size ${tSeg.aroll.size[0]}x${tSeg.aroll.size[1]}px` +
        (tSeg.aroll.border ? `, ${tSeg.aroll.border.color} border` : "")
      );
      parts.push(`Speaker in ${shape} PIP at bottom-right`);
    }

    // Text overlays
    if (tSeg?.text_overlays?.length) {
      for (const overlay of tSeg.text_overlays) {
        layers.push(`TEXT: "${overlay.text.slice(0, 40)}..." at (${overlay.position[0]}, ${overlay.position[1]})`);
      }
      parts.push(`${tSeg.text_overlays.length} text overlay(s)`);
    }

    // Captions
    layers.push(`CAPTIONS: Word-by-word highlighted subtitles at bottom`);
    parts.push("Animated captions with word highlighting");

    // Transitions
    if (tSeg?.transition_in) {
      parts.push(`Enters with ${tSeg.transition_in.type} transition`);
    }

    // Scroll
    if (tSeg?.broll?.scroll) {
      parts.push(
        `B-roll scrolls ${tSeg.broll.scroll.direction} at ${tSeg.broll.scroll.speed.toFixed(1)}px/frame`
      );
    }

    const description = `[${seg.globalStart.toFixed(1)}–${seg.globalEnd.toFixed(1)}s] ${parts.join(". ")}.` +
      ` Speech: "${seg.text.slice(0, 60)}${seg.text.length > 60 ? "..." : ""}"`;

    return {
      segmentId: seg.id,
      description,
      layers,
    };
  });
}
