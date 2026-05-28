import type { TimelineDefinition, TimelineSegment } from "@/lib/types/timeline";
import type { EditCommand, EditResult } from "@/lib/types/editCommand";

/**
 * Applies a list of edit commands to a timeline, returning a new timeline.
 * Each command is applied sequentially. Failed commands are logged but don't stop execution.
 */
export function executeCommands(
  timeline: TimelineDefinition,
  commands: EditCommand[]
): EditResult {
  let current = deepCloneTimeline(timeline);
  const applied: EditCommand[] = [];
  const failed: { command: EditCommand; reason: string }[] = [];

  for (const cmd of commands) {
    try {
      current = applyCommand(current, cmd);
      applied.push(cmd);
    } catch (err) {
      failed.push({
        command: cmd,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const summary = applied.length > 0
    ? `Applied ${applied.length} change${applied.length > 1 ? "s" : ""}: ${applied.map((c) => c.description).join("; ")}`
    : "No changes applied";

  return { timeline: current, appliedCommands: applied, failedCommands: failed, summary };
}

function applyCommand(
  timeline: TimelineDefinition,
  cmd: EditCommand
): TimelineDefinition {
  const segments = cmd.segmentId
    ? timeline.segments.filter((s) => s.id === cmd.segmentId)
    : timeline.segments;

  if (cmd.segmentId && segments.length === 0) {
    throw new Error(`Segment ${cmd.segmentId} not found`);
  }

  switch (cmd.type) {
    case "swap_broll":
      return applySwapBroll(timeline, segments, cmd.params);

    case "resize_pip":
      return applyResizePIP(timeline, segments, cmd.params);

    case "move_pip":
      return applyMovePIP(timeline, segments, cmd.params);

    case "change_layout":
      return applyChangeLayout(timeline, segments, cmd.params);

    case "update_caption_style":
      return applyUpdateCaptionStyle(timeline, cmd.params);

    case "change_transition":
      return applyChangeTransition(timeline, segments, cmd.params);

    case "toggle_hook":
      return applyToggleHook(timeline, cmd.params);

    case "adjust_timing":
      return applyAdjustTiming(timeline, segments, cmd.params);

    case "change_color_grade":
      return applyChangeColorGrade(timeline, cmd.params);

    case "update_text":
      return applyUpdateText(timeline, segments, cmd.params);

    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

function applySwapBroll(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const action = params.action as string | undefined;
  const newId = params.newBrollId as string | undefined;

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s)) return s;
      if (action === "remove") {
        return { ...s, broll: { ...s.broll, src: "" } };
      }
      if (newId) {
        return { ...s, broll: { ...s.broll, src: newId } };
      }
      return s;
    }),
  };
}

function applyResizePIP(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const size = params.size as number;
  if (!size || size < 50 || size > 800) throw new Error("PIP size must be 50-800px");

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s) || !s.aroll) return s;
      return { ...s, aroll: { ...s.aroll, size: [size, size] as [number, number] } };
    }),
  };
}

function applyMovePIP(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const position = params.position as [number, number];
  if (!position || !Array.isArray(position)) throw new Error("Position must be [x, y]");

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s) || !s.aroll) return s;
      return { ...s, aroll: { ...s.aroll, position } };
    }),
  };
}

function applyChangeLayout(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const layout = params.layout as TimelineSegment["layout"];
  const validLayouts = ["full_screen", "pip_overlay", "vertical_split", "side_by_side"];
  if (!validLayouts.includes(layout)) throw new Error(`Invalid layout: ${layout}`);

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s)) return s;
      return { ...s, layout };
    }),
  };
}

function applyUpdateCaptionStyle(
  tl: TimelineDefinition,
  params: Record<string, unknown>
): TimelineDefinition {
  const updatedCaptions = { ...tl.captions };
  const updatedStyle = { ...tl.captions.style };

  if (params.fontSize !== undefined) updatedStyle.fontSize = params.fontSize as number;
  if (params.color !== undefined) updatedStyle.color = params.color as string;
  if (params.highlightColor !== undefined) updatedStyle.highlightColor = params.highlightColor as string;

  updatedCaptions.style = updatedStyle;
  if (params.position) updatedCaptions.position = params.position as [number, number];

  return { ...tl, captions: updatedCaptions };
}

function applyChangeTransition(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const type = params.type as string;
  const durationFrames = (params.durationFrames as number) ?? 8;

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s)) return s;
      if (type === "none") {
        return { ...s, transition_in: undefined };
      }
      return { ...s, transition_in: { type, duration_frames: durationFrames } };
    }),
  };
}

function applyToggleHook(
  tl: TimelineDefinition,
  params: Record<string, unknown>
): TimelineDefinition {
  const enabled = params.enabled as boolean;

  if (!enabled) {
    return { ...tl, hook: null };
  }

  return {
    ...tl,
    hook: {
      type: "text",
      text: (params.text as string) ?? tl.hook?.text ?? "Watch this!",
      duration_frames: 45,
      position: [540, 960],
      style: { fontSize: 56, fontWeight: "bold", color: "#FFFFFF", textAlign: "center" },
      animation: {
        type: (params.animation as "pop" | "slide_up" | "typewriter" | "fade_in") ?? "pop",
        duration_frames: 15,
      },
    },
  };
}

function applyAdjustTiming(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const action = params.action as "extend" | "shorten";
  const frames = params.frames as number;
  const delta = action === "extend" ? frames : -frames;

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s)) return s;
      return { ...s, end_frame: Math.max(s.start_frame + 15, s.end_frame + delta) };
    }),
  };
}

function applyChangeColorGrade(
  tl: TimelineDefinition,
  params: Record<string, unknown>
): TimelineDefinition {
  return {
    ...tl,
    color_grade: {
      ...tl.color_grade,
      ...(params.temperature !== undefined && { temperature: params.temperature as "warm" | "neutral" | "cool" }),
      ...(params.saturation !== undefined && { saturation: params.saturation as number }),
      ...(params.contrast !== undefined && { contrast: params.contrast as number }),
      ...(params.brightness !== undefined && { brightness: params.brightness as number }),
    },
  };
}

function applyUpdateText(
  tl: TimelineDefinition,
  segments: TimelineSegment[],
  params: Record<string, unknown>
): TimelineDefinition {
  const text = params.text as string;

  return {
    ...tl,
    segments: tl.segments.map((s) => {
      if (!segments.includes(s)) return s;
      if (s.text_overlays.length === 0) return s;
      return {
        ...s,
        text_overlays: s.text_overlays.map((o) => ({ ...o, text })),
      };
    }),
  };
}

function deepCloneTimeline(tl: TimelineDefinition): TimelineDefinition {
  return JSON.parse(JSON.stringify(tl));
}
