import React from "react";
import {
  AbsoluteFill, Series, useCurrentFrame, useVideoConfig, interpolate, spring, Easing,
} from "remotion";

/**
 * MotionLibraryProbe — a SELF-CONTAINED render-test for the 16 motion-library patterns.
 *
 * Step B of docs/NEXT-SESSION-HANDOFF.md ("Render-test the 16 motion patterns"). This comp
 * demonstrates EACH of the 16 patterns from docs/motion-library/ as its own short labeled
 * segment, animating only simple shapes / text / divs — NO external media, NO OffthreadVideo
 * of real clips (public/ assets are not present in this worktree). It exists to PROVE that the
 * patterns in the motion-library catalogue render (no error, no black frame) on the real
 * Remotion path; `scripts/motion-library-check.mjs` probes its rendered output per-segment.
 *
 * Authoring rules followed (docs/remotion-authoring.md §6, docs/motion-library/README.md):
 *   - NO CSS transitions/animations — every motion is driven by useCurrentFrame() +
 *     interpolate/spring (frame is LOCAL inside each Series.Sequence, starts at 0).
 *   - Repo default ease: Easing.bezier(0.16,1,0.3,1) with both ends clamped.
 *   - All timing in FRAMES; per-pattern duration is constant + frame-aligned.
 *   - Each segment shows the pattern NAME as a caption + a non-black background so the
 *     brightness probe always sees visible content.
 *
 * Canvas: 1080x1920 @ 30fps (VDIM). 16 patterns × SEG_FRAMES each.
 */

const FONT = "Inter, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, monospace";

// repo default ease (clamped both ends) — see docs/remotion-authoring.md §2
const ease = {
  easing: Easing.bezier(0.16, 1, 0.3, 1),
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

// Per-pattern segment length, in FRAMES. 16 patterns total.
export const SEG_FRAMES = 36;
export const PATTERN_COUNT = 16;
export const PROBE_DURATION = SEG_FRAMES * PATTERN_COUNT;

// Ordered list of the 16 motion-library patterns (the probe's manifest; the check script
// re-derives this same order so its per-segment labels line up with the render).
// push-in/pull-out is ONE catalogue entry (it shows both halves in a single segment).
export const PATTERNS: string[] = [
  // camera (4)
  "push-in_pull-out", "camera-pan", "orbit", "parallax",
  // elements (5)
  "draw-on", "scale-pop", "slide-in", "mask-reveal", "number-counter",
  // text (4)
  "kinetic-typography", "word-highlight", "typewriter", "lower-third",
  // transitions (3)
  "whip-pan", "match-cut", "cross-dissolve",
];

// Distinct, non-black per-segment background tints so the brightness probe always sees
// content AND each segment reads as its own scene. Indexed by pattern position.
const BG: string[] = [
  "#13233f", "#3f1320", "#143b2a", "#2a1340", "#1a1a30",
  "#3a2a10", "#103a3a", "#2f1530", "#1e3010", "#301010",
  "#102a3a", "#2a103a", "#0e2020", "#202a10", "#301a10",
  "#10302a", "#1a1040",
];

const ACCENT = "#5b9cf0";        // repo accent — purer blue (docs/remotion-authoring.md §5)
const ACCENT_SOFT = "#9cc3fb";

// Human-readable label for a pattern key (the combined camera entry uses an underscore).
const displayName = (key: string) => key.replace("_", " / ");

// ── Caption: the pattern NAME, shown bottom-center of every segment (always-on, bright). ──
const Caption: React.FC<{ index: number; name: string }> = ({ index, name }) => {
  const frame = useCurrentFrame();
  // small fade+rise in for the label (frame-driven, no CSS transition)
  const inP = interpolate(frame, [0, 8], [0, 1], ease);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 150,
        textAlign: "center",
        opacity: inP,
        transform: `translateY(${(1 - inP) * 16}px)`,
      }}
    >
      <div style={{ fontFamily: MONO, fontSize: 26, color: ACCENT_SOFT, letterSpacing: 2 }}>
        {String(index + 1).padStart(2, "0")} / {PATTERN_COUNT}
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 58, color: "#fff", marginTop: 8 }}>
        {displayName(name)}
      </div>
    </div>
  );
};

// A reusable demo card / shape so segments look like distinct scenes.
const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  position: "absolute",
  borderRadius: 26,
  background: "rgba(8,12,16,0.72)",
  border: `2px solid ${ACCENT}`,
  boxShadow: `0 18px 50px rgba(0,0,0,0.5), 0 0 26px rgba(91,156,240,0.35)`,
  ...extra,
});

const CX = 540; // canvas center X (1080/2)
const CY = 760; // demo content vertical center (above the caption)

// ──────────────────────────────────────────────────────────────────────────
// CAMERA patterns (transform on a WORLD layer — docs/motion-library/camera.md)
// ──────────────────────────────────────────────────────────────────────────

// A "world" of tiles the camera moves over.
const World: React.FC = () => (
  <>
    {Array.from({ length: 12 }).map((_, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      return (
        <div
          key={i}
          style={card({
            left: 120 + col * 230,
            top: 360 + row * 230,
            width: 190,
            height: 190,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: ACCENT_SOFT,
            fontFamily: MONO,
            fontSize: 44,
            fontWeight: 700,
          })}
        >
          {i + 1}
        </div>
      );
    })}
  </>
);

// Combined "push-in / pull-out" catalogue entry: push-in for the first half, then a
// pull-out reveal for the second half (one segment shows both halves of the pattern).
const PushInPullOut: React.FC = () => {
  const frame = useCurrentFrame();
  const half = SEG_FRAMES / 2;
  // push 1→1.3 (first half), then pull 1.3→0.7 (second half)
  const camS = interpolate(frame, [0, half, SEG_FRAMES], [1, 1.3, 0.7], ease);
  const camY = interpolate(frame, [0, half], [0, -36], ease);
  return (
    <AbsoluteFill
      style={{ transform: `translateY(${camY}px) scale(${camS})`, transformOrigin: "50% 42%" }}
    >
      <World />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 300,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 30,
          color: ACCENT_SOFT,
        }}
      >
        {frame < half ? "push-in" : "pull-out"}
      </div>
    </AbsoluteFill>
  );
};

const CameraPan: React.FC = () => {
  const frame = useCurrentFrame();
  const camX = interpolate(frame, [0, 10, SEG_FRAMES], [120, 120, -520], ease);
  return (
    <AbsoluteFill style={{ transform: `translateX(${camX}px) scale(1.1)`, transformOrigin: "0 0" }}>
      <World />
    </AbsoluteFill>
  );
};

const Orbit: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const items = Array.from({ length: 7 });
  const R = 230;
  return (
    <>
      {items.map((_, i) => {
        const ang = (i / items.length) * Math.PI * 2 + (frame / fps) * 1.6;
        const inn = interpolate(frame, [i * 2, i * 2 + 14], [0, 1], ease);
        const x = CX + Math.cos(ang) * R;
        const y = CY + Math.sin(ang) * R * 0.78;
        return (
          <div
            key={i}
            style={card({
              left: x - 55,
              top: y - 55,
              width: 110,
              height: 110,
              opacity: inn * 0.95,
              transform: `scale(${0.6 + 0.4 * inn})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontFamily: MONO,
              fontSize: 40,
            })}
          >
            {i + 1}
          </div>
        );
      })}
    </>
  );
};

const Parallax: React.FC = () => {
  const frame = useCurrentFrame();
  const camX = interpolate(frame, [0, SEG_FRAMES], [260, -260], ease);
  return (
    <>
      {/* background layer — drifts slower (k=0.45) */}
      <AbsoluteFill style={{ transform: `translateX(${camX * 0.45}px)`, opacity: 0.55 }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 60 + i * 150,
              top: 420,
              width: 90,
              height: 600,
              borderRadius: 18,
              background: "rgba(120,150,200,0.4)",
            }}
          />
        ))}
      </AbsoluteFill>
      {/* foreground layer — full speed */}
      <AbsoluteFill style={{ transform: `translateX(${camX}px)` }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            style={card({ left: 160 + i * 250, top: 620, width: 180, height: 280 })}
          />
        ))}
      </AbsoluteFill>
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// ELEMENT patterns (docs/motion-library/elements.md)
// ──────────────────────────────────────────────────────────────────────────

const DrawOn: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = spring({ frame, fps, config: { damping: 200 } });
  const x1 = 200, y1 = 520, x2 = 880, y2 = 980;
  const d = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
  const total = 1600;
  const flow = -(frame * 3) % 28;
  return (
    <svg width={1080} height={1920} style={{ position: "absolute", inset: 0 }}>
      <path d={d} stroke={ACCENT} strokeOpacity={0.28} strokeWidth={8} fill="none"
        strokeDasharray={total} strokeDashoffset={total * (1 - draw)} strokeLinecap="round" />
      <path d={d} stroke={ACCENT_SOFT} strokeWidth={4} fill="none"
        strokeDasharray="4 24" strokeDashoffset={flow} strokeOpacity={draw}
        style={{ filter: `drop-shadow(0 0 8px ${ACCENT})` }} />
      <circle cx={x1} cy={y1} r={16} fill={ACCENT} opacity={draw} />
      <circle cx={x2} cy={y2} r={16} fill={ACCENT} opacity={draw} />
    </svg>
  );
};

const ScalePop: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <>
      {Array.from({ length: 3 }).map((_, i) => {
        const appear = i * 6;
        const s = spring({ frame: frame - appear, fps, config: { damping: 20, stiffness: 110 } });
        if (frame < appear - 2) return null;
        return (
          <div
            key={i}
            style={card({
              left: 180 + i * 250,
              top: CY - 130,
              width: 200,
              height: 260,
              opacity: s,
              transform: `translateY(${(1 - s) * 24}px) scale(${0.92 + 0.08 * s})`,
              transformOrigin: "center top",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontFamily: MONO,
              fontSize: 52,
            })}
          >
            {i + 1}
          </div>
        );
      })}
    </>
  );
};

const SlideIn: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <>
      {Array.from({ length: 3 }).map((_, i) => {
        const appear = i * 5;
        const p = interpolate(frame, [appear, appear + 12], [0, 1], ease);
        const fromX = -600;
        return (
          <div
            key={i}
            style={card({
              left: 220,
              top: 520 + i * 170,
              width: 640,
              height: 130,
              opacity: p,
              transform: `translateX(${(1 - p) * fromX}px)`,
              display: "flex",
              alignItems: "center",
              paddingLeft: 30,
              color: ACCENT_SOFT,
              fontFamily: FONT,
              fontWeight: 700,
              fontSize: 40,
            })}
          >
            panel {i + 1}
          </div>
        );
      })}
    </>
  );
};

const MaskReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const r = interpolate(frame, [2, SEG_FRAMES - 4], [100, 0], ease);
  return (
    <div
      style={{
        position: "absolute",
        left: 140,
        top: 520,
        width: 800,
        height: 480,
        borderRadius: 26,
        overflow: "hidden",
        clipPath: `inset(0 ${r}% 0 0)`,
        background: `linear-gradient(120deg, ${ACCENT}, ${ACCENT_SOFT})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#08121a",
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: 64,
      }}
    >
      REVEAL
    </div>
  );
};

const NumberCounter: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const v = interpolate(frame, [2, SEG_FRAMES - 4], [0, 92.5], ease);
  const s = spring({ frame, fps, config: { damping: 20, stiffness: 110 } });
  return (
    <div
      style={card({
        left: CX - 320,
        top: CY - 160,
        width: 640,
        height: 320,
        transform: `scale(${0.92 + 0.08 * s})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
      })}
    >
      <div style={{ fontFamily: MONO, fontWeight: 800, fontSize: 130, color: ACCENT_SOFT }}>
        {v.toFixed(1)}%
      </div>
      <div style={{ fontFamily: FONT, fontSize: 30, color: "#9fb0c0", marginTop: 8 }}>
        accuracy
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// TEXT patterns (docs/motion-library/text.md)
// ──────────────────────────────────────────────────────────────────────────

const KineticTypography: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = ["MAKE", "EVERY", "WORD", "POP"];
  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        right: 80,
        top: CY - 120,
        textAlign: "center",
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: 92,
        color: "#fff",
        lineHeight: 1.1,
      }}
    >
      {words.map((w, i) => {
        const s = spring({ frame: frame - i * 4, fps, config: { damping: 14 } });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: 24,
              opacity: s,
              transform: `translateY(${(1 - s) * 24}px) scale(${0.8 + 0.2 * s})`,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

const WordHighlight: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  // start/end in seconds across the ~1.2s segment (stand-in for MMS word times)
  const words = [
    { w: "this", start: 0.0, end: 0.3 },
    { w: "word", start: 0.3, end: 0.6 },
    { w: "is", start: 0.6, end: 0.8 },
    { w: "active", start: 0.8, end: 1.2 },
  ];
  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        right: 80,
        top: CY - 60,
        textAlign: "center",
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: 84,
      }}
    >
      {words.map((wd, i) => {
        const on = t >= wd.start && t < wd.end;
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: 22,
              color: on ? ACCENT_SOFT : "rgba(255,255,255,0.4)",
              transform: `scale(${on ? 1.12 : 1})`,
            }}
          >
            {wd.w}
          </span>
        );
      })}
    </div>
  );
};

const Typewriter: React.FC = () => {
  const frame = useCurrentFrame();
  const text = "> rendering motion library...";
  const n = Math.floor(Math.max(0, frame) * 0.9);
  const shown = text.slice(0, n);
  const caret = Math.floor(frame / 8) % 2 ? "_" : " ";
  return (
    <div
      style={card({
        left: 120,
        top: CY - 90,
        width: 840,
        height: 180,
        display: "flex",
        alignItems: "center",
        paddingLeft: 32,
        color: ACCENT_SOFT,
        fontFamily: MONO,
        fontSize: 42,
      })}
    >
      {shown}
      <span style={{ color: "#fff" }}>{caret}</span>
    </div>
  );
};

const LowerThird: React.FC = () => {
  const frame = useCurrentFrame();
  const appear = 2;
  const hold = 20;
  const inP = interpolate(frame, [appear, appear + 10], [0, 1], ease);
  const outP = interpolate(frame, [appear + hold, appear + hold + 10], [1, 0], ease);
  const vis = inP * outP;
  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        top: CY,
        width: 720,
        height: 160,
        borderRadius: 16,
        background: "rgba(8,12,16,0.85)",
        borderLeft: `10px solid ${ACCENT}`,
        boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
        opacity: vis,
        transform: `translateX(${(1 - inP) * -60}px)`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        paddingLeft: 36,
      }}
    >
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 50, color: "#fff" }}>
        Jane Director
      </div>
      <div style={{ fontFamily: FONT, fontSize: 30, color: ACCENT_SOFT, marginTop: 6 }}>
        Motion Designer
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// TRANSITION patterns (docs/motion-library/transitions.md)
// Each is shown self-contained within ONE segment (A→B inside the segment).
// ──────────────────────────────────────────────────────────────────────────

const transPanel = (label: string, bg: string): React.CSSProperties => ({
  position: "absolute",
  inset: 0,
  background: bg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: FONT,
  fontWeight: 900,
  fontSize: 140,
  color: "#fff",
});

const WhipPan: React.FC = () => {
  const frame = useCurrentFrame();
  const at = 14, dur = 7, blurPx = 24;
  const o = interpolate(frame, [at, at + dur], [0, -100], ease); // outgoing %
  const inc = interpolate(frame, [at, at + dur], [100, 0], ease); // incoming %
  return (
    <>
      <div style={{ ...transPanel("A", "#14304f"), transform: `translateX(${o}%)`, filter: `blur(${(Math.abs(o) / 100) * blurPx}px)` }}>A</div>
      <div style={{ ...transPanel("B", "#4f1430"), transform: `translateX(${inc}%)`, filter: `blur(${(Math.abs(inc) / 100) * blurPx}px)` }}>B</div>
    </>
  );
};

const MatchCut: React.FC = () => {
  const frame = useCurrentFrame();
  // match-cut is a COMPOSITION constraint: the shared circle lands at the SAME box on
  // both sides of the cut. Demonstrate: scene swaps at the midpoint, circle stays put.
  const half = SEG_FRAMES / 2;
  const sceneA = frame < half;
  const bg = sceneA ? "#103040" : "#301040";
  const label = sceneA ? "shot A" : "shot B";
  return (
    <AbsoluteFill style={{ background: bg }}>
      {/* shared anchor element — identical box across the cut */}
      <div
        style={{
          position: "absolute",
          left: CX - 160,
          top: CY - 160,
          width: 320,
          height: 320,
          borderRadius: "50%",
          background: `radial-gradient(circle at 40% 35%, ${ACCENT_SOFT}, ${ACCENT})`,
          boxShadow: `0 0 50px ${ACCENT}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 440,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 40,
          color: "#cdd8e4",
        }}
      >
        {label} — anchor holds
      </div>
    </AbsoluteFill>
  );
};

const CrossDissolve: React.FC = () => {
  const frame = useCurrentFrame();
  const at = 8, dur = 18;
  const out = interpolate(frame, [at, at + dur], [1, 0], ease);
  const inc = interpolate(frame, [at, at + dur], [0, 1], ease);
  return (
    <>
      <div style={{ ...transPanel("B", "linear-gradient(120deg,#1a4060,#2a6080)"), opacity: inc }}>B</div>
      <div style={{ ...transPanel("A", "linear-gradient(120deg,#602a40,#a04060)"), opacity: out }}>A</div>
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Segment registry — pattern name → renderer. Order MUST match PATTERNS.
// ──────────────────────────────────────────────────────────────────────────

const RENDERERS: Record<string, React.FC> = {
  "push-in_pull-out": PushInPullOut,
  "camera-pan": CameraPan,
  "orbit": Orbit,
  "parallax": Parallax,
  "draw-on": DrawOn,
  "scale-pop": ScalePop,
  "slide-in": SlideIn,
  "mask-reveal": MaskReveal,
  "number-counter": NumberCounter,
  "kinetic-typography": KineticTypography,
  "word-highlight": WordHighlight,
  "typewriter": Typewriter,
  "lower-third": LowerThird,
  "whip-pan": WhipPan,
  "match-cut": MatchCut,
  "cross-dissolve": CrossDissolve,
};

const Segment: React.FC<{ index: number; name: string }> = ({ index, name }) => {
  const Body = RENDERERS[name];
  return (
    <AbsoluteFill style={{ background: BG[index] ?? "#16202c", overflow: "hidden" }}>
      {/* faint header label so the top of the frame is never black */}
      <div
        style={{
          position: "absolute",
          top: 110,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 28,
          color: "rgba(180,200,225,0.65)",
          letterSpacing: 3,
        }}
      >
        MOTION-LIBRARY PROBE
      </div>
      {Body ? <Body /> : null}
      <Caption index={index} name={name} />
    </AbsoluteFill>
  );
};

export const MotionLibraryProbe: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0f16" }}>
      <Series>
        {PATTERNS.map((name, i) => (
          <Series.Sequence key={name} durationInFrames={SEG_FRAMES}>
            <Segment index={i} name={name} />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};
