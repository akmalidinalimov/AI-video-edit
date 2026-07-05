/**
 * Style tokens = the VARIANT axis for motion graphics.
 *
 * Because Remotion renders inline styles (not Tailwind classes), the component
 * "variant" is realized through a resolved token set rather than cva classNames.
 * Each component reads `resolveTokens(input.style)` and styles itself — so a
 * single component supports every family variant + the profile-derived variant.
 *
 * Values are re-implemented (palette facts), NOT copied from ReelStack source —
 * per the "re-implement + tokens only" decision (spec §1, §6).
 */
import type { SpringName, StyleRef } from "../contract";

export interface ResolvedTokens {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  palette: string[];
  fontFamily: string;
  fontMono: string;
  spring: { damping: number; stiffness: number };
  radius: number;
}

export const SPRINGS: Record<SpringName, { damping: number; stiffness: number }> = {
  smooth: { damping: 200, stiffness: 100 },
  snappy: { damping: 20, stiffness: 200 },
  gentle: { damping: 15, stiffness: 80 },
  bouncy: { damping: 8, stiffness: 100 },
  glass: { damping: 12, stiffness: 120 },
};

const SANS = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const FAMILY_TOKENS: Record<Exclude<StyleRef["family"], "profile">, ResolvedTokens> = {
  glass: {
    bg: "#EFEAF2", surface: "rgba(255,255,255,0.55)", text: "#1B1730", textMuted: "#5B5570",
    accent: "#8B7FE8", palette: ["#7FE8D4", "#8B7FE8", "#E89BC4", "#F2D88F"],
    fontFamily: SANS, fontMono: MONO, spring: SPRINGS.glass, radius: 28,
  },
  dark: {
    bg: "#0A0A0B", surface: "#16181C", text: "#FAFAFA", textMuted: "#9F9FA9",
    accent: "#D4663A", palette: ["#D4663A", "#4285F4", "#FF4D9B", "#4FC46A"],
    fontFamily: SANS, fontMono: MONO, spring: SPRINGS.snappy, radius: 20,
  },
  paper: {
    bg: "#F0EDE8", surface: "#FBF9F5", text: "#1A1A1A", textMuted: "#6A655C",
    accent: "#D4663A", palette: ["#D4663A", "#1E3A27", "#1E7A45", "#C0392B"],
    fontFamily: SANS, fontMono: MONO, spring: SPRINGS.snappy, radius: 16,
  },
  warm: {
    bg: "#09090B", surface: "#18181B", text: "#FAFAFA", textMuted: "#A1A1AA",
    accent: "#F99C00", palette: ["#F99C00", "#00D294", "#EF4444"],
    fontFamily: SANS, fontMono: MONO, spring: SPRINGS.snappy, radius: 22,
  },
  forbidden: {
    bg: "#1A1418", surface: "#241A22", text: "#F3E9EC", textMuted: "#B59AA6",
    accent: "#D97757", palette: ["#D97757", "#C4506B", "#6B5BD9", "#A87FE8"],
    fontFamily: SANS, fontMono: MONO, spring: SPRINGS.glass, radius: 0,
  },
};

const NEUTRAL: ResolvedTokens = {
  bg: "#0B0B0E", surface: "#17171C", text: "#FFFFFF", textMuted: "#A0A0AA",
  accent: "#625FFF", palette: ["#625FFF", "#00D294", "#FCBB00", "#FF5C7A"],
  fontFamily: SANS, fontMono: MONO, spring: SPRINGS.gentle, radius: 18,
};

/** Resolve a StyleRef to concrete tokens. `profile` uses injected StyleProfile tokens. */
export function resolveTokens(style: StyleRef | undefined): ResolvedTokens {
  if (!style || style.family === "profile") {
    const t = style?.tokens;
    if (!t) return NEUTRAL;
    return {
      bg: t.bg ?? NEUTRAL.bg,
      surface: t.surface ?? NEUTRAL.surface,
      text: t.text ?? NEUTRAL.text,
      textMuted: t.text_muted ?? NEUTRAL.textMuted,
      accent: t.accent ?? NEUTRAL.accent,
      palette: t.palette ?? NEUTRAL.palette,
      fontFamily: t.font_family ?? NEUTRAL.fontFamily,
      fontMono: NEUTRAL.fontMono,
      spring: t.spring ? SPRINGS[t.spring] : NEUTRAL.spring,
      radius: NEUTRAL.radius,
    };
  }
  return FAMILY_TOKENS[style.family];
}
