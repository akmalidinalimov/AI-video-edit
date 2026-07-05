/**
 * motion-design-library.ts — the MOTION-DESIGN style library + motion tokens for the
 * REMOTION render path (the mirror of style-library.ts, which is for AI footage).
 *
 * AI footage gets a Kling-keyword style; everything Remotion renders (motion graphics,
 * captions, overlays on AI footage) gets a MOTION-DESIGN style: design tokens (palette,
 * type, radius) PLUS motion tokens (spring/energy/transition). Chosen ONCE per video for
 * consistency, mapped to the MGCS FAMILY_TOKENS. Sourced from 2026 motion-design research
 * (Apple Liquid Glass, Carbon, Material 3 easing, Remotion springs, School of Motion…).
 *
 * This is the Remotion half of the Phase-2 visual KB seam + the data behind the
 * motion-designer skill (.claude/skills/motion-designer).
 */

// ── Shared MOTION TOKENS (the craft layer — used by any style + the designer skill) ──

/** Spring presets, Remotion spring() shape. damping ≈ 2·√(stiffness·mass) is critical (no bounce). */
export const SPRING_PRESETS = {
  smooth: { damping: 26, stiffness: 170, mass: 1 },     // no visible bounce — default enters/moves
  snappy: { damping: 22, stiffness: 280, mass: 0.9 },   // fast, tight — caption pops, emphasis
  gentle: { damping: 20, stiffness: 90, mass: 1.1 },    // slow, calm — backgrounds, hero
  bouncy: { damping: 9, stiffness: 130, mass: 1 },      // 2–3 oscillations — playful
  glass: { damping: 14, stiffness: 120, mass: 1 },      // one soft overshoot — premium product
  dramatic: { damping: 18, stiffness: 60, mass: 1.4 },  // heavy, weighty — title cards
  mechanical: { damping: 40, stiffness: 350, mass: 1 }, // near-instant — counters, tickers
} as const;
export type SpringName = keyof typeof SPRING_PRESETS;

/** Cubic-bezier presets (x1,y1,x2,y2), verified vs easings.net / Material 3 / Motion. */
export const EASING_PRESETS = {
  standard: [0.2, 0, 0, 1],          // M3 workhorse
  decelerate: [0.05, 0.7, 0.1, 1],   // entering elements (slow-in)
  accelerate: [0.3, 0, 0.8, 0.15],   // exiting elements (fast-out)
  smoothOut: [0.16, 1, 0.3, 1],      // expensive reveals (easeOutExpo)
  quintOut: [0.22, 1, 0.36, 1],      // premium + safe
  overshoot: [0.34, 1.56, 0.64, 1],  // pops/badges (easeOutBack)
  anticipate: [0.36, 0, 0.66, -0.56],// wind-up before launch
  dramaticInOut: [0.83, 0, 0.17, 1], // camera push-ins, scene swaps
  linear: [0, 0, 1, 1],              // ONLY loops/marquees/progress
} as const;

/** Durations + stagger in FRAMES at 30fps (M3 tokens). */
export const MOTION_TIMING = { short: 4, medium: 10, long: 16, xlong: 24, staggerStep: 3, holdAfterSettle: 15 } as const;

// ── Style library ──

export type MotionStyleCategory =
  | "clean" | "editorial" | "corporate" | "data_viz" | "glass"
  | "bold_kinetic" | "brutalist" | "retro" | "tech_hud" | "playful" | "dimensional_3d";

export type MgcsFamily = "glass" | "dark" | "paper" | "warm" | "forbidden";

export interface MotionDesignStyle {
  id: string;
  name: string;
  category: MotionStyleCategory;
  description: string; // what it is + what it evokes
  whenToUse: string;   // selection signal
  /** design tokens (map to MGCS ResolvedTokens) + motion */
  tokens: {
    bg: string; surface: string; text: string; textMuted: string; accent: string;
    palette: string[];
    fontFamily: string; fontMono: string;
    radius: number;
    spring: SpringName;            // the style's signature spring
    energy: "low" | "medium" | "high";
    transition: string;           // entrance/transition vocabulary
  };
  complexity: "low" | "medium" | "high";
  mgcsFamily: MgcsFamily;          // which existing MGCS family it maps to
}

const SANS = (primary: string) => `${primary}, Inter, Montserrat, system-ui, -apple-system, sans-serif`;
const MONO = "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const MOTION_DESIGN_LIBRARY: MotionDesignStyle[] = [
  // ── CLEAN / EDITORIAL / CORPORATE / DATA / GLASS (R1) ──
  { id: "swiss_minimal", name: "Swiss / International", category: "clean", complexity: "medium", mgcsFamily: "paper", description: "Grid-driven asymmetric layouts, neutral grotesque type, generous whitespace — precise, authoritative, timeless.", whenToUse: "Premium B2B, fintech, thought-leadership — competence and clarity over personality.", tokens: { bg: "#FFFFFF", surface: "#F4F4F4", text: "#0A0A0A", textMuted: "#5A5A5A", accent: "#FF3B00", palette: ["#0A0A0A", "#FF3B00", "#1A1A1A", "#F4F4F4"], fontFamily: SANS("Helvetica Now"), fontMono: MONO, radius: 0, spring: "snappy", energy: "low", transition: "hard cuts + clean grid-aligned slides, no fades" } },
  { id: "editorial_magazine", name: "Editorial / Magazine", category: "editorial", complexity: "high", mgcsFamily: "paper", description: "Print-magazine logic — serif/sans pairings, columns, kickers, typographic rhythm.", whenToUse: "Storytelling reels, fashion/culture/lifestyle, quote-driven narrative where pacing matters.", tokens: { bg: "#FAF8F3", surface: "#FFFFFF", text: "#1C1A17", textMuted: "#6B6459", accent: "#A8331E", palette: ["#1C1A17", "#A8331E", "#1B3A5B", "#6B6459"], fontFamily: SANS("GT Sectra"), fontMono: MONO, radius: 2, spring: "gentle", energy: "low", transition: "cross-fades + line-by-line type reveals, page-turn wipes" } },
  { id: "corporate_clean", name: "Corporate-Clean / SaaS", category: "corporate", complexity: "medium", mgcsFamily: "dark", description: "Calm whitespace-rich dark-mode product look, restrained accents, confident type — modern, trustworthy software.", whenToUse: "SaaS/product explainers, feature reels, tech brands — the default 'looks expensive and modern' pick.", tokens: { bg: "#0B0B0F", surface: "#16161D", text: "#EDEDF0", textMuted: "#8A8A99", accent: "#6E56CF", palette: ["#6E56CF", "#3B82F6", "#EDEDF0", "#16161D"], fontFamily: SANS("Aeonik"), fontMono: MONO, radius: 14, spring: "smooth", energy: "medium", transition: "soft slides + scale-ins, staggered list reveals, spring counters" } },
  { id: "dataviz_clean", name: "Data-Viz Clean", category: "data_viz", complexity: "high", mgcsFamily: "dark", description: "Dashboard-grade charts + number layouts with a disciplined accessible categorical palette — rigor and credibility.", whenToUse: "Stat reels, 'by the numbers', report highlights, finance/analytics data storytelling.", tokens: { bg: "#161616", surface: "#262626", text: "#F4F4F4", textMuted: "#8D8D8D", accent: "#8A3FFC", palette: ["#8A3FFC", "#33B1FF", "#007D79", "#FF7EB6", "#FA4D56"], fontFamily: SANS("IBM Plex Sans"), fontMono: "IBM Plex Mono, " + MONO, radius: 6, spring: "smooth", energy: "medium", transition: "bars grow from baseline, lines draw on, counters spring up, sequential series" } },
  { id: "liquid_glass", name: "Liquid Glass", category: "glass", complexity: "high", mgcsFamily: "glass", description: "Translucent layered surfaces with blur, refraction, and motion-reactive specular highlights — depth and premium hardware.", whenToUse: "Premium/Apple-adjacent tech, app showcases, luxury product reels over rich backdrops.", tokens: { bg: "#EFEAF2", surface: "rgba(255,255,255,0.12)", text: "#FFFFFF", textMuted: "rgba(255,255,255,0.6)", accent: "#0A84FF", palette: ["#0A84FF", "#7FE8D4", "#8B7FE8", "#E89BC4"], fontFamily: SANS("SF Pro"), fontMono: MONO, radius: 22, spring: "glass", energy: "medium", transition: "morphs + fluid scale, specular highlight sweeps tracking motion" } },
  { id: "flat_2_0", name: "Flat Design 2.0", category: "clean", complexity: "low", mgcsFamily: "paper", description: "Flat simplicity with restored depth — faint shadows, soft gradients, layered backgrounds, micro-motion.", whenToUse: "Consumer apps, onboarding/explainer reels, friendly brands needing warmth without skeuomorphism.", tokens: { bg: "#FFFFFF", surface: "#F7F8FA", text: "#1F2430", textMuted: "#6B7280", accent: "#6366F1", palette: ["#6366F1", "#8B5CF6", "#F59E0B", "#1F2430"], fontFamily: SANS("GT Walsheim"), fontMono: MONO, radius: 20, spring: "bouncy", energy: "high", transition: "pop-in scale, soft slides, playful micro-interactions" } },
  { id: "kinetic_editorial", name: "Kinetic Typographic", category: "editorial", complexity: "high", mgcsFamily: "dark", description: "Oversized expressive type as the whole frame — variable letterforms that scale, stretch and react.", whenToUse: "Hook reels, quote/punchline content, brand statements where the words are the visual.", tokens: { bg: "#0E0E0E", surface: "#161616", text: "#FFFFFF", textMuted: "#8A8A8A", accent: "#E6FF00", palette: ["#0E0E0E", "#FFFFFF", "#E6FF00", "#FF2D55"], fontFamily: SANS("Monument Extended"), fontMono: MONO, radius: 0, spring: "snappy", energy: "high", transition: "hard cuts on the beat, scale-punches, variable-axis morphs" } },
  { id: "warm_minimal", name: "Warm Minimal", category: "clean", complexity: "low", mgcsFamily: "warm", description: "Minimalism with warmth — umber/ochre/sand neutrals, soft contrast, gentle motion — calm, human, premium.", whenToUse: "Wellness, beauty, lifestyle, premium DTC, founder/personal brands — human and unhurried.", tokens: { bg: "#F5EFE6", surface: "#EBE3D7", text: "#2B2722", textMuted: "#8B8175", accent: "#B5654A", palette: ["#B5654A", "#5B6B52", "#2B2722", "#EBE3D7"], fontFamily: SANS("GT Alpina"), fontMono: MONO, radius: 12, spring: "gentle", energy: "low", transition: "soft fades, slow drifts, gentle scale — nothing snaps" } },

  // ── BOLD / BRUTALIST / RETRO / TECH / PLAYFUL / 3D (R2) ──
  { id: "bold_kinetic", name: "Bold Kinetic Typography", category: "bold_kinetic", complexity: "medium", mgcsFamily: "dark", description: "Oversized type animating word-by-word with elastic physics — letters stretch, bounce and settle to punch a message.", whenToUse: "Talking-head / caption-led short-form where audio carries the message — the default for creator reels.", tokens: { bg: "#0A0A0A", surface: "#161616", text: "#FFFFFF", textMuted: "#8A8A8A", accent: "#FFE600", palette: ["#0A0A0A", "#FFFFFF", "#FFE600", "#FF3D00", "#00E5FF"], fontFamily: SANS("Clash Display"), fontMono: MONO, radius: 6, spring: "bouncy", energy: "high", transition: "per-word stagger, overshoot-and-settle, synced to audio beats" } },
  { id: "brutalist", name: "Neo-Brutalist", category: "brutalist", complexity: "low", mgcsFamily: "forbidden", description: "Raw, loud, deliberately 'wrong' — hard borders, flat saturated blocks, system fonts, zero radius.", whenToUse: "Dev tools, music, streetwear, counter-culture brands wanting friction and personality over polish.", tokens: { bg: "#F4F0E6", surface: "#FFFFFF", text: "#111111", textMuted: "#555555", accent: "#0000FF", palette: ["#111111", "#0000FF", "#FF0000", "#FFFF00", "#F4F0E6"], fontFamily: SANS("Helvetica"), fontMono: "Berkeley Mono, " + MONO, radius: 0, spring: "mechanical", energy: "medium", transition: "hard cut/snap, marquee scrolls, instant state-flips" } },
  { id: "neon_cyber", name: "Neon-Cyber / Deep Glow", category: "tech_hud", complexity: "medium", mgcsFamily: "dark", description: "Void-black canvas with layered neon blooms, glowing grids and HUD motifs — futuristic, high-energy.", whenToUse: "Tech launches, crypto/AI, gaming, music drops — anything selling 'the future' or a night-time mood.", tokens: { bg: "#0D0D0F", surface: "#15151A", text: "#F0F0F0", textMuted: "#6A6A75", accent: "#00D4FF", palette: ["#00D4FF", "#8B45FF", "#B8FF4A", "#FF2D78", "#0D0D0F"], fontFamily: SANS("Geist"), fontMono: MONO, radius: 6, spring: "smooth", energy: "high", transition: "glow-in pulses, scanning sweeps, animated gradient accents" } },
  { id: "retro_terminal", name: "Retro Terminal / CRT", category: "retro", complexity: "low", mgcsFamily: "dark", description: "Phosphor-green monospace on void black with scanlines, blinking cursor, dithered grain — booting-an-old-machine.", whenToUse: "Hacker/security, indie dev, lo-fi/underground brands, 'loading…' and data-reveal moments.", tokens: { bg: "#000000", surface: "#0A0F0A", text: "#00FF41", textMuted: "#00A02A", accent: "#FFAA00", palette: ["#000000", "#00FF41", "#33FF66", "#FFAA00"], fontFamily: "VT323, " + MONO, fontMono: "VT323, " + MONO, radius: 0, spring: "mechanical", energy: "low", transition: "typewriter reveal (steps), blinking cursor, line-by-line print" } },
  { id: "vaporwave", name: "Vaporwave Mograph", category: "retro", complexity: "medium", mgcsFamily: "dark", description: "Neon-pastel pink/cyan, perspective grids, marble statues, VHS glitch — melancholic dreamy mall-futurism.", whenToUse: "Music/lo-fi, nostalgia creators, fashion drops, ironic dreamy mood pieces (use sparingly — cliché risk).", tokens: { bg: "#1A0B2E", surface: "#2D1B4E", text: "#FFFFFF", textMuted: "#C8A2E0", accent: "#FF6AD5", palette: ["#FF6AD5", "#05FFA1", "#01CDFE", "#B967FF", "#FFFB96"], fontFamily: SANS("Monument Extended"), fontMono: "VT323, " + MONO, radius: 12, spring: "gentle", energy: "medium", transition: "slow zooms + drift, chromatic-aberration glitch hits, parallax over grid" } },
  { id: "playful_memphis", name: "Playful / New Memphis", category: "playful", complexity: "medium", mgcsFamily: "paper", description: "Bright clashing colors, geometric confetti (squiggles, dots, arcs), rounded shapes, bouncy motion — joyful.", whenToUse: "Kids/education, consumer apps, food, fintech-with-personality — friendly, approachable warmth.", tokens: { bg: "#FFF4E0", surface: "#FFFFFF", text: "#1A1A2E", textMuted: "#6B6B7B", accent: "#FF5470", palette: ["#FF5470", "#FFC93C", "#3DCCC7", "#7B61FF", "#1A1A2E"], fontFamily: SANS("Fredoka"), fontMono: MONO, radius: 22, spring: "bouncy", energy: "high", transition: "pop-in, wiggle, squash-and-stretch with stagger" } },
  { id: "dimensional_3d", name: "3D Extruded / Dimensional", category: "dimensional_3d", complexity: "high", mgcsFamily: "glass", description: "Letters and objects with real depth — extrusion, bevels, inflated 'plush' volumes or high-gloss chrome.", whenToUse: "Product launches, hero titles, gaming, beauty/luxury — when a headline needs to feel like an object.", tokens: { bg: "#EDE8F5", surface: "#FFFFFF", text: "#1B1B2F", textMuted: "#6E6E8A", accent: "#6C5CE7", palette: ["#6C5CE7", "#FD79A8", "#74B9FF", "#FDCB6E", "#1B1B2F"], fontFamily: SANS("Clash Display"), fontMono: MONO, radius: 16, spring: "glass", energy: "medium", transition: "rotate-in on Y/X, parallax, inflate-and-settle" } },
  { id: "maximalist_gradient", name: "Maximalist Gradient (Grainy)", category: "bold_kinetic", complexity: "medium", mgcsFamily: "dark", description: "Dense layered composition over animated mesh/aurora gradients with noise-grain — immersive emotional color fields.", whenToUse: "Music, beauty, lifestyle, brand mood films, abstract intros — content selling a feeling.", tokens: { bg: "#120A1E", surface: "#1E1330", text: "#FAF7FF", textMuted: "#A89CC0", accent: "#FF7A59", palette: ["#FF7A59", "#7B61FF", "#00C2A8", "#FFD166", "#120A1E"], fontFamily: SANS("Satoshi"), fontMono: MONO, radius: 16, spring: "gentle", energy: "medium", transition: "gradient drift/morph, slow color shift, grain shimmer behind static type" } },
];

const BY_ID = new Map(MOTION_DESIGN_LIBRARY.map((s) => [s.id, s]));
export const getMotionStyle = (id: string): MotionDesignStyle | undefined => BY_ID.get(id);
export const motionStylesByCategory = (c: MotionStyleCategory): MotionDesignStyle[] => MOTION_DESIGN_LIBRARY.filter((s) => s.category === c);

/** Map the reference class → motion-design shortlist + default (mirrors the AI-video selector). */
export const REF_CLASS_TO_MOTION_STYLE: Record<string, { default: string; shortlist: string[] }> = {
  realistic_person: { default: "bold_kinetic", shortlist: ["bold_kinetic", "corporate_clean", "warm_minimal", "editorial_magazine"] },
  realistic_scene: { default: "corporate_clean", shortlist: ["corporate_clean", "editorial_magazine", "swiss_minimal", "warm_minimal"] },
  product: { default: "corporate_clean", shortlist: ["corporate_clean", "liquid_glass", "dataviz_clean", "dimensional_3d"] },
  motion_graphics: { default: "bold_kinetic", shortlist: ["bold_kinetic", "dataviz_clean", "neon_cyber", "maximalist_gradient", "swiss_minimal"] },
  cartoon_animation: { default: "playful_memphis", shortlist: ["playful_memphis", "flat_2_0", "bold_kinetic"] },
  paper_explainer: { default: "swiss_minimal", shortlist: ["swiss_minimal", "editorial_magazine", "flat_2_0"] },
};

export const FALLBACK_MOTION_STYLE = "corporate_clean";

export function defaultMotionStyleFor(refClass?: string): MotionDesignStyle {
  const entry = refClass ? REF_CLASS_TO_MOTION_STYLE[refClass] : undefined;
  return getMotionStyle(entry?.default ?? FALLBACK_MOTION_STYLE) ?? getMotionStyle(FALLBACK_MOTION_STYLE)!;
}

export function buildMotionStyleSelectionInstruction(refClass: string | undefined, context: string): string {
  const ids = (refClass && REF_CLASS_TO_MOTION_STYLE[refClass]?.shortlist) || MOTION_DESIGN_LIBRARY.slice(0, 8).map((s) => s.id);
  const list = ids.map((id) => getMotionStyle(id)).filter(Boolean).map((s) => `- ${s!.id}: ${s!.description} (use when: ${s!.whenToUse}; energy: ${s!.tokens.energy})`).join("\n");
  return [
    `Pick the SINGLE best MOTION-DESIGN style for this video's graphics + captions. Reference class: "${refClass ?? "unknown"}".`,
    `Video context: ${context}`,
    `Candidates:`,
    list,
    `Return ONLY JSON: {"motionStyleId": "<one id>", "reason": "<short>"}`,
  ].join("\n");
}

/** Resolve a motion style into the MGCS ResolvedTokens shape (drops mass; the renderer wants {damping,stiffness}). */
export function motionStyleToTokens(id: string): {
  bg: string; surface: string; text: string; textMuted: string; accent: string;
  palette: string[]; fontFamily: string; fontMono: string;
  spring: { damping: number; stiffness: number }; radius: number;
} {
  const s = getMotionStyle(id) ?? defaultMotionStyleFor(undefined);
  const sp = SPRING_PRESETS[s.tokens.spring];
  return {
    bg: s.tokens.bg, surface: s.tokens.surface, text: s.tokens.text, textMuted: s.tokens.textMuted, accent: s.tokens.accent,
    palette: s.tokens.palette, fontFamily: s.tokens.fontFamily, fontMono: s.tokens.fontMono,
    spring: { damping: sp.damping, stiffness: sp.stiffness }, radius: s.tokens.radius,
  };
}
