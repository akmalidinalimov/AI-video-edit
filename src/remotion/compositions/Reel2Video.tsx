import React from "react";
import {
  AbsoluteFill, Sequence, Audio, Video, OffthreadVideo,
  useCurrentFrame, useVideoConfig, interpolate, spring, getRemotionEnvironment, staticFile,
} from "remotion";

/** Resolve a relative public/ path to a Remotion staticFile URL; pass http/absolute through. */
const rsrc = (s?: string) => (!s ? s : (s.startsWith("http") || s.startsWith("/") || s.includes("://")) ? s : staticFile(s));

/**
 * Reel2Video — clones the IMG_6298 editing GRAMMAR (different from reel 1's circle-PIP):
 *   ACT 1 (split): vertical 50/50-ish split — real A-roll on TOP (1080×840), AI talking
 *                  character on BOTTOM (1080×1080 square) — with white "pill" labels.
 *   ACT 2 (tutorial): a PiP presenter avatar + a dark-mode NODE-GRAPH motion graphic.
 *   Persistent corner logo · hard cuts · final "Comment AI" CTA card.
 *
 * Per-segment DISTINCT sources (unlike StyleCloneVideo's single continuous video), because
 * reel 2 alternates between 2 real clips + many AI character clips.
 */

// Use OffthreadVideo EVERYWHERE (incl. rendering). The old `isRendering ? Video : OffthreadVideo`
// used the HTML5 <Video> during render, which seeks per frame and emits ONE black frame at each
// clip's first frame (the cut "glitch"). OffthreadVideo extracts the exact frame via ffmpeg (no
// seek-black) and — since Remotion 4.x — renders audio too (volume/toneFrequency/audioStreamIndex
// props), so the top A-roll dialogue is preserved.
const VideoTag = OffthreadVideo;

export interface Reel2Segment {
  startFrame: number; endFrame: number;
  kind: "split" | "tutorial";
  // split (Act 1)
  topSrc?: string; topLabel?: string;          // A-roll, pre-cropped to ~1080×840
  topFromSec?: number;                          // seek into the A-roll source (variety)
  bottomSrc?: string; bottomLabel?: string;     // AI character, 1:1
  bottomFromSec?: number;                         // seek into the character clip (per-turn slice)
  // tutorial (Act 2)
  presenterSrc?: string;                        // avatar PiP clip (e.g. talking Bob explainer)
  presenterMuted?: boolean;                     // default true; set false so the explainer's AUDIO plays
  presenterLoop?: boolean;                      // default true; set false for a one-shot narration clip
  titleCardLines?: string[];                    // intro card text
  node?: boolean;                               // show the step-flow ("how it's made")
  cta?: string;                                 // final CTA text
}
export interface Reel2Props {
  fps: number; width: number; height: number; durationInFrames: number;
  logoText?: string;
  musicSrc?: string;
  segments: Reel2Segment[];
}

const TOP_H = 840;       // top A-roll band height (canvas 1080×1920)
const BOTTOM_Y = 840;    // bottom square starts here (1080×1080)

// ── white text in a black rounded pill ──
const PillLabel: React.FC<{ text: string; y: number }> = ({ text, y }) => (
  <div style={{ position: "absolute", top: y, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 30 }}>
    <div style={{
      background: "rgba(0,0,0,0.78)", color: "#fff", fontFamily: "Inter, Arial, sans-serif",
      fontWeight: 700, fontSize: 34, padding: "10px 26px", borderRadius: 999, letterSpacing: 0.2,
      whiteSpace: "nowrap",
    }}>{text}</div>
  </div>
);

const CornerLogo: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    position: "absolute", top: 26, right: 30, zIndex: 40, color: "#fff",
    fontFamily: "Inter, Arial, sans-serif", fontWeight: 900, fontSize: 40,
    textShadow: "0 2px 8px rgba(0,0,0,0.5)", opacity: 0.95,
  }}>{text}</div>
);

// ── simple, render-safe inline SVG icons (no emoji → no tofu in headless render) ──
const StepIcon: React.FC<{ kind: string }> = ({ kind }) => {
  const c = { width: 46, height: 46, viewBox: "0 0 48 48", fill: "none", stroke: "#cfe3ff", strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "image") return (<svg {...c}><rect x={7} y={10} width={34} height={28} rx={4} /><circle cx={17} cy={20} r={3.5} /><path d="M11 36 L21 25 L29 32 L34 27 L41 35" /></svg>);
  if (kind === "mic") return (<svg {...c}><rect x={19} y={6} width={10} height={20} rx={5} /><path d="M14 21 a10 10 0 0 0 20 0" /><path d="M24 31 V40 M18 40 H30" /></svg>);
  if (kind === "sync") return (<svg {...c}><path d="M9 13 h24 a5 5 0 0 1 5 5 v9 a5 5 0 0 1-5 5 H20 l-8 6 v-6 a5 5 0 0 1-3-5 v-14z" /><path d="M17 22 v6 M23 19 v12 M29 22 v6" /></svg>);
  if (kind === "split") return (<svg {...c}><rect x={7} y={11} width={34} height={26} rx={3} /><path d="M24 11 V37" /></svg>);
  return null;
};

// ── Act-2 "how it's made" — animated numbered STEP CHIPS with icons (replaces the abstract node-graph) ──
const STEPS = [
  { icon: "image", label: "Generate a character image", sub: "Nano Banana Pro" },
  { icon: "mic", label: "Add your real audio", sub: "" },
  { icon: "sync", label: "Lip-sync the character", sub: "Wan 2.7" },
  { icon: "split", label: "Edit the split-screen", sub: "" },
];
const StepFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const title = spring({ frame, fps, config: { damping: 200 } });
  const TOP0 = 250, GAP = 232, BADGE = 84;
  return (
    <AbsoluteFill style={{ background: "#0e1116" }}>
      <div style={{ position: "absolute", top: 80, left: 0, right: 0, textAlign: "center", color: "#fff", fontFamily: "Inter, Arial, sans-serif", fontWeight: 900, fontSize: 66, opacity: title, transform: `translateY(${(1 - title) * -20}px)` }}>How it's made</div>
      {/* animated connector line behind the number badges */}
      <svg width="1080" height="1280" style={{ position: "absolute", top: 0, left: 0 }}>
        {STEPS.slice(0, -1).map((_, i) => {
          const y0 = TOP0 + i * GAP + BADGE / 2, y1 = TOP0 + (i + 1) * GAP + BADGE / 2;
          const p = spring({ frame: frame - (i * 14 + 18), fps, config: { damping: 200 } });
          return <line key={i} x1={132} y1={y0} x2={132} y2={y0 + (y1 - y0) * p} stroke="#2c3a4a" strokeWidth={5} />;
        })}
      </svg>
      {STEPS.map((s, i) => {
        const sp = spring({ frame: frame - (i * 14 + 8), fps, config: { damping: 18, stiffness: 120 } });
        return (
          <div key={i} style={{ position: "absolute", left: 90, top: TOP0 + i * GAP, right: 90, display: "flex", alignItems: "center", gap: 26, opacity: sp, transform: `translateX(${(1 - sp) * -40}px)` }}>
            <div style={{ width: BADGE, height: BADGE, borderRadius: "50%", flexShrink: 0, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, Arial, sans-serif", fontWeight: 900, fontSize: 44, boxShadow: "0 8px 24px rgba(59,130,246,0.45)" }}>{i + 1}</div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 22, background: "#1b2230", border: "2px solid #2c3a4a", borderRadius: 18, padding: "22px 28px", boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
              <StepIcon kind={s.icon} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ color: "#e6edf3", fontFamily: "Inter, Arial, sans-serif", fontWeight: 700, fontSize: 40, lineHeight: 1.1 }}>{s.label}</div>
                {s.sub ? <div style={{ color: "#7d8aa0", fontFamily: "Inter, Arial, sans-serif", fontWeight: 600, fontSize: 27, marginTop: 5 }}>{s.sub}</div> : null}
              </div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const fitCover: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

const SegmentView: React.FC<{ seg: Reel2Segment; index: number }> = ({ seg, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = seg.endFrame - seg.startFrame;
  // HARD CUTS between segments: only the FIRST segment fades in (gentle open). Fading every
  // segment from opacity 0 over the black root canvas produced a black frame + fade-up at each
  // cut (the ~3.37s "glitch"). Internal cuts are instant — fully continuous.
  const fadeIn = index === 0
    ? interpolate(frame, [0, 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;

  if (seg.kind === "split") {
    return (
      <AbsoluteFill style={{ opacity: fadeIn }}>
        {/* TOP: real A-roll band */}
        <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: TOP_H, overflow: "hidden", background: "#000" }}>
          {seg.topSrc && <VideoTag src={rsrc(seg.topSrc)} startFrom={Math.round((seg.topFromSec ?? 0) * fps)} style={fitCover} />}
        </div>
        {seg.topLabel && <PillLabel text={seg.topLabel} y={TOP_H - 70} />}
        {/* BOTTOM: AI character square */}
        <div style={{ position: "absolute", top: BOTTOM_Y, left: 0, width: 1080, height: 1080, overflow: "hidden", background: "#000" }}>
          {seg.bottomSrc && <VideoTag src={rsrc(seg.bottomSrc)} startFrom={Math.round((seg.bottomFromSec ?? 0) * fps)} muted style={fitCover} />}
        </div>
        {seg.bottomLabel && <PillLabel text={seg.bottomLabel} y={BOTTOM_Y + 24} />}
      </AbsoluteFill>
    );
  }

  // tutorial (Act 2)
  return (
    <AbsoluteFill style={{ opacity: fadeIn, background: "#0e1116" }}>
      {/* top 2/3: node-graph or title card */}
      {seg.titleCardLines ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", height: 1280 }}>
          <div style={{ textAlign: "center", color: "#fff", fontFamily: "Inter, Arial, sans-serif" }}>
            {seg.titleCardLines.map((l, i) => (
              <div key={i} style={{ fontWeight: i === 0 ? 900 : 700, fontSize: i === 0 ? 64 : 44, margin: "8px 0", opacity: i === 0 ? 1 : 0.85 }}>{l}</div>
            ))}
          </div>
        </AbsoluteFill>
      ) : seg.node ? (
        <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: 1280 }}><StepFlow /></div>
      ) : null}
      {/* presenter PiP bottom — the talking Bob explainer (audio ON when presenterMuted=false) */}
      {seg.presenterSrc && (
        <div style={{ position: "absolute", bottom: 60, left: 60, width: 460, height: 460, borderRadius: 24, overflow: "hidden", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", border: "3px solid rgba(255,255,255,0.15)", zIndex: 20 }}>
          <VideoTag src={rsrc(seg.presenterSrc)} loop={seg.presenterLoop !== false} muted={seg.presenterMuted !== false} style={fitCover} />
        </div>
      )}
      {/* CTA */}
      {seg.cta && (() => {
        const s = spring({ frame: frame - Math.max(0, dur - 90), fps, config: { damping: 12 } });
        return (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", zIndex: 50 }}>
            <div style={{ transform: `scale(${0.7 + 0.3 * s})`, opacity: s, color: "#fff", fontFamily: "Inter, Arial, sans-serif", fontWeight: 900, fontSize: 88, textShadow: "0 4px 24px rgba(0,0,0,0.7)" }}>{seg.cta}</div>
          </AbsoluteFill>
        );
      })()}
    </AbsoluteFill>
  );
};

export const Reel2Video: React.FC<Reel2Props> = ({ segments, logoText = "AI", musicSrc }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {segments.map((seg, i) => (
        <Sequence
          key={i}
          from={seg.startFrame}
          durationInFrames={seg.endFrame - seg.startFrame}
          // Preload each clip's <Video> ~0.5s before its in-point so the HTML5 video element
          // has finished seeking to `startFrom` by frame 0 — otherwise it renders ONE black
          // frame at the cut (the seek-black, separate from the fade we removed above).
          premountFor={15}
          name={`seg${i}-${seg.kind}`}
        >
          <SegmentView seg={seg} index={i} />
        </Sequence>
      ))}
      <CornerLogo text={logoText} />
      {musicSrc && <Audio src={rsrc(musicSrc)} volume={0.25} />}
    </AbsoluteFill>
  );
};
