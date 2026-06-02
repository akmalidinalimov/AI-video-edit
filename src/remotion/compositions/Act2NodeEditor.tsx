import React from "react";
import {
  AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring,
  OffthreadVideo, staticFile,
} from "remotion";

/**
 * Act2NodeEditor — replicates the reference's "how it's made" NODE-EDITOR SCREENCAST style
 * (IMG_6298 24s→end): dark dot-grid canvas, a glowing title header, floating node cards with
 * output handles, a command-palette popup, animated bezier connectors, a moving cursor, and a
 * persistent presenter PiP — populated with OUR resources (Bob image/clip + real A-roll), narrated
 * by the existing Bob explainer clip (audio on). Pure Remotion motion graphics; no AI generation.
 *
 * Beat timing is choreographed to Bob's narration (bob-explainer.mp4, sentence times):
 *   [0.0-1.2] "Here's how it's made."                         -> title
 *   [1.6-3.2] "First, I create a cartoon character image."     -> Image Generator node
 *   [3.5-7.5] "Then I add my real voice, and an AI tool lip-syncs..." -> Audio node + Video node + connectors
 *   [7.7-9.1] "Then I edit into a split-screen video."         -> Output (split-screen) node
 *   [9.4-10 ] "Try it yourself."                               -> CTA
 */

// OffthreadVideo with a generous delayRender timeout — Act-2 plays several clips at once and the
// default 28s proxy-fetch timeout flakes under contention; 120s makes plain renders reliable.
const VideoTag: React.FC<React.ComponentProps<typeof OffthreadVideo>> = (p) => (
  <OffthreadVideo delayRenderTimeoutInMilliseconds={120000} {...p} />
);
const rsrc = (s: string) => (s.startsWith("http") || s.startsWith("/") || s.includes("://")) ? s : staticFile(s);
const FONT = "Inter, Arial, sans-serif";

// ── assets (ours) ──
const A = {
  presenter: "uploads/gen/reel2/bob-explainer.mp4",
  charImg: "uploads/gen/reel2/bob-bear.png",
  videoClip: "uploads/gen/reel2/turns/bottom-t1.mp4",
  realTop: "uploads/gen/reel2/turns/top-t1.mp4",
};

// ── dark dotted canvas ──
const DotGridCanvas: React.FC = () => (
  <AbsoluteFill style={{
    background: "#0e1116",
    backgroundImage: "radial-gradient(circle, #1c2533 1.6px, transparent 1.6px)",
    backgroundSize: "42px 42px",
  }} />
);

// ── glowing top title ──
const TitleHeader: React.FC = () => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  return (
    <div style={{ position: "absolute", top: 54, left: 0, right: 0, textAlign: "center", opacity: s, transform: `translateY(${(1 - s) * -18}px)`, zIndex: 30 }}>
      <div style={{ color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 64, textShadow: "0 0 28px rgba(99,102,241,0.55)" }}>How it&apos;s made</div>
      <div style={{ color: "#9fb0c9", fontFamily: FONT, fontWeight: 600, fontSize: 32, marginTop: 6 }}>Real voice → AI character</div>
    </div>
  );
};

type NodeProps = { x: number; y: number; w: number; appear: number; title: string; sub?: string; accent: string; children?: React.ReactNode; };
const NodeCard: React.FC<NodeProps> = ({ x, y, w, appear, title, sub, accent, children }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: frame - appear, fps, config: { damping: 18, stiffness: 120 } });
  if (frame < appear) return null;
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: w, background: "#1b2230",
      border: "2px solid #2c3a4a", borderRadius: 16, boxShadow: "0 10px 34px rgba(0,0,0,0.55)",
      opacity: s, transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: "center", overflow: "hidden", zIndex: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid #2c3a4a" }}>
        <div style={{ width: 14, height: 14, borderRadius: 4, background: accent, flexShrink: 0 }} />
        <div style={{ color: "#e6edf3", fontFamily: FONT, fontWeight: 700, fontSize: 26 }}>{title}</div>
        {sub ? <div style={{ color: "#7d8aa0", fontFamily: FONT, fontWeight: 600, fontSize: 20, marginLeft: "auto" }}>{sub}</div> : null}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
      {/* output handle on right edge */}
      <div style={{ position: "absolute", right: -9, top: "55%", width: 16, height: 16, borderRadius: "50%", background: accent, border: "3px solid #0e1116" }} />
    </div>
  );
};

// ── animated audio waveform bars ──
const Waveform: React.FC<{ bars?: number }> = ({ bars = 38 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, height: 84 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const h = 14 + Math.abs(Math.sin(i * 0.6 + frame * 0.25)) * 64;
        return <div key={i} style={{ flex: 1, height: h, background: "#3b82f6", borderRadius: 3, opacity: 0.85 }} />;
      })}
    </div>
  );
};

// ── command palette popup ──
const PALETTE = [
  { label: "Text", c: "#a78bfa" }, { label: "Image Generator", c: "#60a5fa" },
  { label: "Video Generator", c: "#34d399" }, { label: "Assistant", c: "#f472b6" },
  { label: "Image Upscaler", c: "#38bdf8" }, { label: "List", c: "#9fb0c9" },
];
const CommandPalette: React.FC<{ x: number; y: number; appear: number; dismiss: number; highlight: number }> = ({ x, y, appear, dismiss, highlight }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (frame < appear || frame > dismiss) return null;
  const s = spring({ frame: frame - appear, fps, config: { damping: 200 } });
  const out = interpolate(frame, [dismiss - 6, dismiss], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 360, background: "#161b22", border: "2px solid #30363d", borderRadius: 14, boxShadow: "0 16px 48px rgba(0,0,0,0.7)", opacity: s * out, transform: `scale(${0.9 + 0.1 * s})`, zIndex: 40, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #30363d", color: "#7d8aa0", fontFamily: FONT, fontSize: 22 }}>Search nodes…</div>
      {PALETTE.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", background: i === highlight ? "#1f6feb33" : "transparent" }}>
          <div style={{ width: 18, height: 18, borderRadius: 5, background: p.c }} />
          <div style={{ color: "#e6edf3", fontFamily: FONT, fontWeight: 600, fontSize: 23 }}>{p.label}</div>
        </div>
      ))}
    </div>
  );
};

// ── animated draw-on bezier connector ──
const Bezier: React.FC<{ x1: number; y1: number; x2: number; y2: number; appear: number; color: string }> = ({ x1, y1, x2, y2, appear, color }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (frame < appear) return null;
  const p = spring({ frame: frame - appear, fps, config: { damping: 200 } });
  const mx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  const len = Math.hypot(x2 - x1, y2 - y1) + Math.abs(mx - x1) * 2 + 200;
  return (
    <svg width="1080" height="1280" style={{ position: "absolute", top: 0, left: 0, zIndex: 5 }}>
      <path d={d} stroke={color} strokeWidth={4} fill="none" strokeDasharray={len} strokeDashoffset={len * (1 - p)} opacity={0.9} />
    </svg>
  );
};

// ── moving cursor (keyframed) ──
const Cursor: React.FC<{ keys: { at: number; x: number; y: number }[] }> = ({ keys }) => {
  const frame = useCurrentFrame();
  const xs = keys.map(k => k.at), X = keys.map(k => k.x), Y = keys.map(k => k.y);
  const x = interpolate(frame, xs, X, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, xs, Y, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <svg width="32" height="36" viewBox="0 0 24 28" style={{ position: "absolute", left: x, top: y, zIndex: 60, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))" }}>
      <path d="M3 2 L3 22 L9 16 L13 25 L16 23 L12 15 L20 15 Z" fill="#fff" stroke="#0e1116" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
};

const fitCover: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

export const Act2NodeEditor: React.FC<{ cta?: string }> = ({ cta = 'Comment "AI"' }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();

  // presenter (Bob) PiP — audio ON; present while he narrates (~10s = 300f), then fade out for the CTA hold
  const pipIn = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pipOut = interpolate(frame, [300, 318], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pipOpacity = pipIn * pipOut;

  const ctaAppear = 300;
  const ctaS = spring({ frame: frame - ctaAppear, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill>
      <DotGridCanvas />
      <TitleHeader />

      {/* IMAGE GENERATOR node — "I create a cartoon character image" (1.6s=48f) */}
      <NodeCard x={70} y={250} w={440} appear={52} title="Image Generator" sub="Nano Banana Pro" accent="#60a5fa">
        <div style={{ width: "100%", height: 300, borderRadius: 10, overflow: "hidden", background: "#000" }}>
          <img src={rsrc(A.charImg)} style={fitCover} />
        </div>
        <div style={{ color: "#9fb0c9", fontFamily: FONT, fontSize: 21, marginTop: 10 }}>friendly cartoon bear, cozy living room</div>
      </NodeCard>

      {/* AUDIO node — "add my real voice" (3.5s=105f) */}
      <NodeCard x={70} y={680} w={440} appear={108} title="Your real voice" sub="A1" accent="#3b82f6">
        <Waveform />
      </NodeCard>

      {/* VIDEO GENERATOR node — "AI tool lip-syncs the character to the audio" (5.3s=160f) */}
      <NodeCard x={600} y={380} w={410} appear={160} title="Video Generator" sub="Wan 2.7" accent="#34d399">
        <div style={{ width: "100%", height: 360, borderRadius: 10, overflow: "hidden", background: "#000" }}>
          {frame >= 160 ? <VideoTag src={rsrc(A.videoClip)} muted style={fitCover} /> : null}
        </div>
      </NodeCard>

      {/* OUTPUT node (split-screen) — "edit into a split-screen video" (7.7s=231f) */}
      <NodeCard x={600} y={820} w={410} appear={231} title="Split-screen edit" accent="#f59e0b">
        <div style={{ width: "100%", height: 250, borderRadius: 10, overflow: "hidden", background: "#000", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "hidden" }}>{frame >= 231 ? <VideoTag src={rsrc(A.realTop)} muted style={fitCover} /> : null}</div>
          <div style={{ flex: 1, overflow: "hidden" }}>{frame >= 231 ? <VideoTag src={rsrc(A.videoClip)} muted style={fitCover} /> : null}</div>
        </div>
      </NodeCard>

      {/* connectors (draw-on) */}
      <Bezier x1={510} y1={420} x2={600} y2={500} appear={168} color="#60a5fa" />{/* image -> video */}
      <Bezier x1={510} y1={760} x2={600} y2={560} appear={176} color="#3b82f6" />{/* audio -> video */}
      <Bezier x1={1010} y1={560} x2={805} y2={820} appear={238} color="#34d399" />{/* video -> output */}

      {/* command palette (before the image node lands) */}
      <CommandPalette x={300} y={300} appear={30} dismiss={52} highlight={1} />

      {/* moving cursor */}
      <Cursor keys={[
        { at: 0, x: 560, y: 1180 }, { at: 30, x: 330, y: 360 }, { at: 52, x: 300, y: 470 },
        { at: 108, x: 300, y: 760 }, { at: 160, x: 760, y: 520 }, { at: 231, x: 780, y: 900 },
        { at: 300, x: 540, y: 980 },
      ]} />

      {/* presenter PiP (Bob, audio ON) */}
      <div style={{ position: "absolute", bottom: 56, left: 56, width: 440, height: 440, borderRadius: 24, overflow: "hidden", boxShadow: "0 12px 44px rgba(0,0,0,0.6)", border: "3px solid rgba(255,255,255,0.16)", opacity: pipOpacity, zIndex: 50 }}>
        <VideoTag src={rsrc(A.presenter)} style={fitCover} />
      </div>

      {/* CTA */}
      {frame >= ctaAppear && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", zIndex: 70, paddingBottom: 150 }}>
          <div style={{ transform: `scale(${0.7 + 0.3 * ctaS})`, opacity: ctaS, color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 84, textShadow: "0 4px 28px rgba(0,0,0,0.8)" }}>{cta}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
