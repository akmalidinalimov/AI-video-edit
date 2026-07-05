/**
 * Adapters: legacy schemas → the unified StyleProfile 2.0 (B1, step 2).
 *
 * These are the non-breaking bridge that lets us flip the engine to emit one
 * schema without a big-bang rewrite. Both adapters always return a value that
 * passes `StyleProfileSchema.parse` (they fill renderer-safe defaults wherever
 * the source pipeline never measured a layer — e.g. VisualBlueprint has no
 * color-grade/audio, so those default to neutral/absent).
 *
 * Type-only imports of the legacy types (erased at runtime) so a `tsx` test can
 * run this file without resolving the `@/` alias.
 */
import type { VisualBlueprint, BlueprintSegment } from "@/lib/types/blueprint";
import type { StyleProfile as LegacyStyleProfile, Segment as LegacySegment } from "@/lib/types/styleProfile";
import { STYLE_PROFILE_VERSION, StyleProfileSchema, type StyleProfile } from "./style-profile";

/* ── helpers ─────────────────────────────────────────────────────────── */
const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const toHex = (c: string | null | undefined, fallback: string): string =>
  c && HEX.test(c.trim()) ? c.trim() : fallback;

function parseResolution(res: string | undefined): [number, number] {
  const m = (res ?? "").match(/(\d+)\s*[x×]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [1080, 1920];
}
function aspectOf(w: number, h: number): StyleProfile["reference_meta"]["aspect_ratio"] {
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(r - 1) < 0.05) return "1:1";
  if (Math.abs(r - 4 / 5) < 0.05) return "4:5";
  return "9:16";
}
function pacingClassFromAsl(asl: number): StyleProfile["pacing"]["pacing_class"] {
  if (asl >= 6) return "slow";
  if (asl >= 2) return "moderate";
  if (asl >= 1) return "fast";
  return "frantic";
}
const TRANSITION_MAP: Record<string, StyleProfile["transitions"]["dominant"][number]> = {
  cut: "hard_cut", hard_cut: "hard_cut", none: "hard_cut",
  fade: "fade", "fade_in": "fade", "fade_out": "fade",
  dissolve: "dissolve", crossfade: "dissolve",
  slide: "slide_left", slide_left: "slide_left", slide_right: "slide_right", slide_up: "slide_up",
  zoom: "zoom", "zoom_in": "zoom", "zoom_punch_in": "zoom",
};
const mapTransition = (s: string | undefined): StyleProfile["transitions"]["dominant"][number] =>
  TRANSITION_MAP[(s ?? "").toLowerCase().trim()] ?? "hard_cut";

/** Renderer-safe default captions block (all required fields valid). */
function defaultCaptions(present: boolean): StyleProfile["captions"] {
  return {
    present,
    render_mode: "word_by_word",
    animation: present ? "word_karaoke" : "none",
    position_norm: [0.5, 0.8],
    text_align: "center",
    text_transform: "none",
    font_class: "sans",
    font_weight: "bold",
    font_size_norm: 0.03,
    fill_color: "#FFFFFF",
    highlight_color: "#FFD700",
    background_color: null,
    padding_px: 0,
    border_radius_px: 0,
    max_words_per_line: 4,
  };
}

/* ── VisualBlueprint → StyleProfile 2.0 (pipeline A) ──────────────────── */
export function fromVisualBlueprint(bp: VisualBlueprint): StyleProfile {
  const W = bp.canvas.width;
  const H = bp.canvas.height;
  const segs = bp.reference.segments ?? [];
  const total = bp.reference.duration || segs.reduce((s, x) => s + (x.end - x.start), 0) || 1;

  const lengths = segs.map((s) => Math.max(0, s.end - s.start));
  const asl = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : total;

  const roleOf = (s: BlueprintSegment): StyleProfile["layout"]["patterns"][number]["role"] => {
    if (s.layout === "pip_overlay") return "broll_overlay";
    if (s.layout === "vertical_split" || s.layout === "side_by_side") return "split_screen";
    if (s.aroll) return "talking_head";
    if (s.broll?.contentType === "screen_recording") return "screen_recording";
    return "fullscreen_broll";
  };

  // group segments by role → one weighted pattern per role (first seg = representative style)
  const byRole = new Map<string, { dur: number; seg: BlueprintSegment }>();
  for (const s of segs) {
    const role = roleOf(s);
    const prev = byRole.get(role);
    const dur = Math.max(0, s.end - s.start);
    if (prev) prev.dur += dur;
    else byRole.set(role, { dur, seg: s });
  }
  const patterns = [...byRole.entries()].map(([role, { dur, seg }]) => ({
    role: role as StyleProfile["layout"]["patterns"][number]["role"],
    aroll: seg.aroll
      ? {
          shape: seg.aroll.shape,
          bbox_norm: [
            clamp01(seg.aroll.boundingBox.x / W), clamp01(seg.aroll.boundingBox.y / H),
            clamp01(seg.aroll.boundingBox.width / W), clamp01(seg.aroll.boundingBox.height / H),
          ] as [number, number, number, number],
          border: seg.aroll.hasBorder
            ? { color: toHex(seg.aroll.borderColor, "#FFFFFF"), width_px: seg.aroll.borderWidth ?? 4 }
            : null,
          motion: "static" as const,
        }
      : null,
    broll: seg.broll
      ? {
          bbox_norm: [
            clamp01(seg.broll.boundingBox.x / W), clamp01(seg.broll.boundingBox.y / H),
            clamp01(seg.broll.boundingBox.width / W), clamp01(seg.broll.boundingBox.height / H),
          ] as [number, number, number, number],
          is_background:
            seg.broll.boundingBox.width >= W * 0.95 && seg.broll.boundingBox.height >= H * 0.95,
        }
      : null,
    weight: clamp01(dur / total),
  }));
  if (patterns.length === 0) {
    patterns.push({ role: "talking_head", aroll: null, broll: null, weight: 1 });
  }

  // captions: derive typography from the reference's text elements (style, not content)
  const allTexts = segs.flatMap((s) => s.texts ?? []);
  const repText = allTexts.find((t) => t.isHeadline) ?? allTexts[0];
  const captions: StyleProfile["captions"] = repText
    ? {
        ...defaultCaptions(true),
        position_norm: [clamp01((repText.boundingBox.x + repText.boundingBox.width / 2) / W), clamp01(repText.boundingBox.y / H)],
        font_weight: repText.fontWeight,
        font_size_norm: clamp01(repText.estimatedFontSize / H),
        fill_color: toHex(repText.color, "#FFFFFF"),
        background_color: repText.backgroundColor ? toHex(repText.backgroundColor, "#000000") : null,
        text_transform: repText.text === repText.text.toUpperCase() && /[A-Z]/.test(repText.text) ? "uppercase" : "none",
      }
    : defaultCaptions(false);

  // narrative b-roll role from the dominant b-roll content type
  const brollType = segs.find((s) => s.broll)?.broll?.contentType;
  const brollRole: StyleProfile["narrative"]["broll_role"] =
    brollType === "screen_recording" ? "screen_recording" : brollType ? "literal_illustration" : "none";

  const profile: StyleProfile = {
    schema_version: STYLE_PROFILE_VERSION,
    reference_meta: {
      duration_s: bp.reference.duration,
      fps: bp.reference.fps,
      resolution: [W, H],
      aspect_ratio: aspectOf(W, H),
    },
    pacing: {
      shot_count: segs.length,
      asl_s: asl,
      cuts_per_minute: total > 0 ? segs.length / (total / 60) : 0,
      shot_lengths_s: lengths,
      pacing_class: pacingClassFromAsl(asl),
    },
    layout: { patterns, layout_change: "sentence_boundary" },
    captions,
    transitions: { dominant: ["hard_cut"], hard_cut_pct: 1, default_duration_frames: 0 },
    motion_graphics: { uses: false, elements: [], anim_personality: "smooth" },
    color: {
      brightness: 1, saturation: 1, contrast: 1, temperature: "neutral",
      dominant_palette: [...new Set(allTexts.map((t) => toHex(t.color, "#FFFFFF")))].slice(0, 8),
      look_name: "neutral",
    },
    audio: {
      music: { present: false, genre: "", mood: "", tempo_bpm: null, energy: "medium" },
      ducking: { enabled: false, depth_db: null },
      sfx: { density_per_min: 0, palette: [] },
    },
    narrative: {
      structure_class: "hook_body_cta",
      hook_type: "none",
      hook_t_norm_end: 0,
      cta: { present: false, type: "none" },
      broll_role: brollRole,
    },
  };
  return StyleProfileSchema.parse(profile);
}

/* ── legacy StyleProfile (TS) → StyleProfile 2.0 (pipeline B) ─────────── */
export function fromLegacyStyleProfile(old: LegacyStyleProfile): StyleProfile {
  const [W, H] = parseResolution(old.source?.resolution);
  const segs = old.segments ?? [];
  const lengths = segs.map((s) => Math.max(0, s.end - s.start));
  const asl = old.editing_rhythm?.avg_segment_duration ?? (lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1);
  const total = old.source?.duration || lengths.reduce((a, b) => a + b, 0) || 1;

  const roleOf = (s: LegacySegment): StyleProfile["layout"]["patterns"][number]["role"] => {
    if (s.layout === "pip_overlay") return "broll_overlay";
    if (s.layout === "vertical_split" || s.layout === "side_by_side") return "split_screen";
    if (s.aroll) return "talking_head";
    if (s.broll) return "fullscreen_broll";
    return "fullscreen_text";
  };

  const byRole = new Map<string, { dur: number; seg: LegacySegment }>();
  for (const s of segs) {
    const role = roleOf(s);
    const dur = Math.max(0, s.end - s.start);
    const prev = byRole.get(role);
    if (prev) prev.dur += dur;
    else byRole.set(role, { dur, seg: s });
  }
  const patterns = [...byRole.entries()].map(([role, { dur, seg }]) => ({
    role: role as StyleProfile["layout"]["patterns"][number]["role"],
    aroll: seg.aroll
      ? {
          shape: seg.aroll.shape,
          bbox_norm: [
            clamp01(seg.aroll.position[0] / W), clamp01(seg.aroll.position[1] / H),
            clamp01((seg.aroll.size[0] ?? 0) / W), clamp01((seg.aroll.size[1] ?? 0) / H),
          ] as [number, number, number, number],
          border: seg.aroll.border ? { color: toHex(seg.aroll.border.color, "#FFFFFF"), width_px: seg.aroll.border.width } : null,
          motion: (seg.aroll.animation ? "linear_reposition" : "static") as "static" | "linear_reposition",
        }
      : old.pip_style
        ? { shape: old.pip_style.shape, bbox_norm: [0.6, 0.05, 0.35, 0.2] as [number, number, number, number], border: old.pip_style.border ? { color: toHex(old.pip_style.border.color, "#FFFFFF"), width_px: old.pip_style.border.width } : null, motion: "static" as const }
        : null,
    broll: seg.broll
      ? {
          bbox_norm: [
            clamp01(seg.broll.position[0] / W), clamp01(seg.broll.position[1] / H),
            clamp01(seg.broll.size[0] / W), clamp01(seg.broll.size[1] / H),
          ] as [number, number, number, number],
          is_background: seg.broll.size[0] >= W * 0.95 && seg.broll.size[1] >= H * 0.95,
        }
      : null,
    weight: clamp01(dur / total),
  }));
  if (patterns.length === 0) patterns.push({ role: "talking_head", aroll: null, broll: null, weight: 1 });

  // captions from text overlays
  const allOverlays = segs.flatMap((s) => s.text_overlays ?? []);
  const rep = allOverlays[0];
  const captions: StyleProfile["captions"] = rep
    ? {
        ...defaultCaptions(true),
        position_norm: [clamp01(rep.position[0] / W), clamp01(rep.position[1] / H)],
        font_weight: rep.style.fontWeight ?? "bold",
        font_size_norm: clamp01((rep.style.fontSize ?? rep.style.size ?? 56) / H),
        fill_color: toHex(rep.style.color, "#FFFFFF"),
        background_color: rep.style.backgroundColor || rep.style.background ? toHex(rep.style.backgroundColor ?? rep.style.background, "#000000") : null,
        padding_px: rep.style.padding ?? 0,
        border_radius_px: rep.style.borderRadius ?? 0,
      }
    : defaultCaptions(false);

  const transitionSet = [...new Set(segs.flatMap((s) => [mapTransition(s.transition_in), mapTransition(s.transition_out)]))];
  const hasCta = segs.some((s) => (s.other_elements ?? []).some((e) => e.type === "cta"));
  const usesMG = segs.some((s) => (s.other_elements ?? []).length > 0);

  const profile: StyleProfile = {
    schema_version: STYLE_PROFILE_VERSION,
    reference_meta: { duration_s: old.source.duration, fps: old.source.fps, resolution: [W, H], aspect_ratio: aspectOf(W, H) },
    pacing: {
      shot_count: old.editing_rhythm?.total_segments ?? segs.length,
      asl_s: asl,
      cuts_per_minute: total > 0 ? segs.length / (total / 60) : 0,
      shot_lengths_s: lengths,
      pacing_class: old.editing_rhythm?.pacing ?? pacingClassFromAsl(asl),
    },
    layout: { patterns, layout_change: "sentence_boundary" },
    captions,
    transitions: {
      dominant: transitionSet.length ? transitionSet : ["hard_cut"],
      hard_cut_pct: old.editing_rhythm?.cut_style === "hard_cut" ? 1 : old.editing_rhythm?.cut_style === "smooth_transition" ? 0 : 0.5,
      default_duration_frames: 0,
    },
    motion_graphics: { uses: usesMG, elements: [], anim_personality: "smooth" },
    color: {
      brightness: old.color_grade?.brightness ?? 1,
      saturation: old.color_grade?.saturation ?? 1,
      contrast: old.color_grade?.contrast ?? 1,
      temperature: old.color_grade?.temperature ?? "neutral",
      dominant_palette: [...new Set(allOverlays.map((o) => toHex(o.style.color, "#FFFFFF")))].slice(0, 8),
      look_name: "neutral",
    },
    audio: {
      music: { present: false, genre: "", mood: "", tempo_bpm: null, energy: "medium" },
      ducking: { enabled: false, depth_db: null },
      sfx: { density_per_min: 0, palette: [] },
    },
    narrative: {
      structure_class: "hook_body_cta",
      hook_type: "none",
      hook_t_norm_end: 0,
      cta: { present: hasCta, type: hasCta ? "follow" : "none" },
      broll_role: segs.some((s) => s.broll) ? "literal_illustration" : "none",
    },
  };
  return StyleProfileSchema.parse(profile);
}
