import React from "react";
import {
  AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, interpolate, spring, Easing,
  OffthreadVideo, staticFile,
} from "remotion";

/**
 * Act2NodeEditor (v3.6) — ELEVATED "how it's made": a premium, REAL-feeling Magnific "Spaces"
 * node editor, built 100% in Remotion (no AI-video UI — gen models render UI text as gibberish).
 *   - cinematic CAMERA: left→right pan across a wide world canvas + 2-layer parallax, then a
 *     zoom-OUT that reveals a dense node network (like the reference).
 *   - ORBIT INTRO: character thumbnails drift/orbit in behind the title.
 *   - GLASS nodes (Magnific structure): label ABOVE the card, content-filled body, dim prompt
 *     caption, left input dots + a right-edge output icon-stack; thin curved wires with a flowing
 *     gradient. Spotlight palette + minimap. Bob presenter PiP narrates (audio on).
 * Beat timing is synced to Bob's narration (bob-explainer.mp4). All node CONTENTS are our real
 * assets (Bob image + Wan 2.7 clip + real A-roll); only the UI/motion is Remotion.
 */

const FONT = "Inter, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, monospace";
const A = {
  presenter: "uploads/gen/reel2/bob-explainer.mp4",
  charImg: "uploads/gen/reel2/bob-bear.png",
  zigImg: "uploads/gen/reel2/zig-bunny.png",
  videoClip: "uploads/gen/reel2/turns/bottom-t1.mp4",
  zigClip: "uploads/gen/reel2/turns/bottom-t2.mp4",
  realTop: "uploads/gen/reel2/turns/top-t1.mp4",
  music: "sfx/act2-bed.mp3",
};
const rsrc = (s: string) => (s.startsWith("http") || s.startsWith("/") || s.includes("://")) ? s : staticFile(s);
const Vid: React.FC<React.ComponentProps<typeof OffthreadVideo>> = (p) => (
  <OffthreadVideo delayRenderTimeoutInMilliseconds={120000} {...p} />
);
const ease = { easing: Easing.bezier(0.16, 1, 0.3, 1), extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

// ── small SVG node icons ──
const Icon: React.FC<{ k: string; s?: number; c?: string }> = ({ k, s = 22, c = "#cfe3ff" }) => {
  const p = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: c, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (k === "image") return (<svg {...p}><rect x={3} y={4} width={18} height={16} rx={3} /><circle cx={8.5} cy={10} r={1.8} /><path d="M5 18 L10 12 L14 16 L17 13 L20 17" /></svg>);
  if (k === "video") return (<svg {...p}><rect x={3} y={5} width={18} height={14} rx={3} /><path d="M10 9 L15 12 L10 15 Z" fill={c} stroke="none" /></svg>);
  if (k === "audio") return (<svg {...p}><path d="M4 10 v4 M8 7 v10 M12 9 v6 M16 6 v12 M20 10 v4" /></svg>);
  if (k === "text") return (<svg {...p}><path d="M5 6 H19 M12 6 V18 M9 18 H15" /></svg>);
  return null;
};

// ── glass node card; label sits ABOVE the card (Magnific style) ──
type NodeProps = { x: number; y: number; w: number; appear: number; label: string; accent: string; caption?: string; ports?: string[]; children?: React.ReactNode };
const NodeCard: React.FC<NodeProps> = ({ x, y, w, appear, label, accent, caption, ports = ["image"], children }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: frame - appear, fps, config: { damping: 20, stiffness: 110 } });
  if (frame < appear - 2) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, opacity: s, transform: `translateY(${(1 - s) * 24}px) scale(${0.92 + 0.08 * s})`, transformOrigin: "center top" }}>
      <div style={{ color: "#8b9bb4", fontFamily: FONT, fontWeight: 600, fontSize: 21, marginBottom: 9, marginLeft: 4, letterSpacing: 0.2 }}>{label}</div>
      <div style={{
        position: "relative", borderRadius: 22,
        background: "linear-gradient(160deg, rgba(38,46,62,0.92), rgba(20,25,36,0.95))",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: `0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 50px -12px ${accent}55`,
        padding: 12,
      }}>
        {children}
        {caption ? <div style={{ color: "#9fb0c9", fontFamily: MONO, fontSize: 17, marginTop: 9, padding: "0 4px 2px", lineHeight: 1.3 }}>{caption}</div> : null}
        {/* left input dot */}
        <div style={{ position: "absolute", left: -7, top: "50%", width: 13, height: 13, borderRadius: "50%", background: "#0b0d12", border: `2px solid ${accent}` }} />
        {/* right output icon-stack */}
        <div style={{ position: "absolute", right: -20, top: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {ports.map((pk, i) => (
            <div key={i} style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(20,25,36,0.96)", border: "1px solid rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(0,0,0,0.5)" }}>
              <Icon k={pk} s={19} c="#aab9d4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const mediaBox: React.CSSProperties = { width: "100%", borderRadius: 12, overflow: "hidden", background: "#000", display: "block" };

// ── flowing curved connector (draw-on + drifting gradient dashes) ──
const Wire: React.FC<{ x1: number; y1: number; x2: number; y2: number; appear: number; color: string }> = ({ x1, y1, x2, y2, appear, color }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (frame < appear) return null;
  const draw = spring({ frame: frame - appear, fps, config: { damping: 200 } });
  const mx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  const total = Math.hypot(x2 - x1, y2 - y1) + Math.abs(mx - x1) * 2 + 160;
  const flow = -((frame - appear) * 3) % 28;
  return (
    <>
      <path d={d} stroke={color} strokeOpacity={0.28} strokeWidth={5} fill="none" strokeDasharray={total} strokeDashoffset={total * (1 - draw)} />
      <path d={d} stroke={color} strokeWidth={2.5} fill="none" strokeDasharray="3 25" strokeDashoffset={flow} strokeOpacity={draw} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
    </>
  );
};

// ── decorative "ghost" mini-nodes that populate the dense graph on zoom-out ──
const GHOSTS = [
  { x: 60, y: 70, k: "image" }, { x: 470, y: 40, k: "text" }, { x: 980, y: 60, k: "video" },
  { x: 1620, y: 120, k: "image" }, { x: 1780, y: 520, k: "audio" }, { x: 40, y: 1140, k: "video" },
  { x: 560, y: 1180, k: "image" }, { x: 1080, y: 1200, k: "text" }, { x: 1640, y: 1120, k: "video" },
  { x: 1980, y: 820, k: "image" }, { x: 250, y: 600, k: "audio" }, { x: 1180, y: 880, k: "image" },
];
const Ghost: React.FC<{ x: number; y: number; k: string; reveal: number }> = ({ x, y, k, reveal }) => (
  <div style={{ position: "absolute", left: x, top: y, width: 150, height: 96, borderRadius: 12, opacity: reveal * 0.5, background: "linear-gradient(160deg, rgba(30,37,51,0.8), rgba(16,20,30,0.85))", border: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <Icon k={k} s={26} c="#5b6b86" />
  </div>
);

// ── Spotlight / command palette ──
const PALETTE = [
  { label: "Text", c: "#a78bfa" }, { label: "Image Generator", c: "#60a5fa" }, { label: "Video Generator", c: "#34d399" },
  { label: "Assistant", c: "#f472b6" }, { label: "Image Upscaler", c: "#38bdf8" }, { label: "List", c: "#9fb0c9" },
];
const Spotlight: React.FC<{ x: number; y: number; appear: number; dismiss: number; highlight: number }> = ({ x, y, appear, dismiss, highlight }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (frame < appear || frame > dismiss) return null;
  const s = spring({ frame: frame - appear, fps, config: { damping: 200 } });
  const out = interpolate(frame, [dismiss - 7, dismiss], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 360, borderRadius: 16, overflow: "hidden", opacity: s * out, transform: `translateY(${(1 - s) * 12}px)`, background: "rgba(16,20,30,0.96)", border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 24px 70px rgba(0,0,0,0.75)", zIndex: 45 }}>
      <div style={{ padding: "13px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#7d8aa0", fontFamily: FONT, fontSize: 21 }}>Search nodes…</div>
      {PALETTE.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: i === highlight ? "rgba(96,165,250,0.18)" : "transparent" }}>
          <div style={{ width: 20, height: 20, borderRadius: 6, background: p.c }} />
          <div style={{ color: "#e6edf3", fontFamily: FONT, fontWeight: 600, fontSize: 22 }}>{p.label}</div>
        </div>
      ))}
    </div>
  );
};

const Cursor: React.FC<{ keys: { at: number; x: number; y: number }[] }> = ({ keys }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, keys.map(k => k.at), keys.map(k => k.x), ease);
  const y = interpolate(frame, keys.map(k => k.at), keys.map(k => k.y), ease);
  return (
    <svg width="30" height="34" viewBox="0 0 24 28" style={{ position: "absolute", left: x, top: y, zIndex: 60, filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.7))" }}>
      <path d="M3 2 L3 22 L9 16 L13 25 L16 23 L12 15 L20 15 Z" fill="#fff" stroke="#0b0d12" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
};

// ── orbit intro: character thumbnails drift in a loose ring ──
const ORBIT = [
  { src: A.charImg, kind: "img", a: 0 }, { src: A.zigImg, kind: "img", a: 1 },
  { src: A.realTop, kind: "vid", a: 2 }, { src: A.videoClip, kind: "vid", a: 3 },
];
const OrbitIntro: React.FC<{ end: number }> = ({ end }) => {
  const frame = useCurrentFrame();
  const gone = interpolate(frame, [end - 16, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (frame > end) return null;
  const cx = 540, cy = 760, R = 300;
  return (
    <AbsoluteFill style={{ opacity: gone, zIndex: 8 }}>
      {ORBIT.map((o, i) => {
        const ang = (i / ORBIT.length) * Math.PI * 2 + frame * 0.012;
        const inn = interpolate(frame, [o.a * 5, o.a * 5 + 22], [0, 1], ease);
        const x = cx + Math.cos(ang) * R - 130, y = cy + Math.sin(ang) * R * 0.78 - 90;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, width: 260, height: 180, borderRadius: 18, overflow: "hidden", opacity: inn * 0.92, transform: `scale(${0.6 + 0.4 * inn})`, border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 18px 50px rgba(0,0,0,0.6)" }}>
            {o.kind === "img" ? <img src={rsrc(o.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Vid src={rsrc(o.src)} muted loop style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const Act2NodeEditor: React.FC<{ cta?: string }> = ({ cta = 'Comment "AI"' }) => {
  const frame = useCurrentFrame(); const { fps, durationInFrames } = useVideoConfig();

  // ── camera keyframes: pan L→R across the world, then zoom OUT ──
  const camX = interpolate(frame, [70, 150, 230, 300, 360, 440], [60, 60, -360, -880, -880, -260], ease);
  const camS = interpolate(frame, [70, 360, 440], [1, 1, 0.52], ease);
  const camY = interpolate(frame, [70, 360, 440], [0, 0, 120], ease);
  const ghostReveal = interpolate(frame, [380, 440], [0, 1], ease);

  // presenter PiP — Bob narrates ~10s (300f), fade out for CTA hold
  const pipIn = interpolate(frame, [6, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pipOut = interpolate(frame, [288, 302], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pip = pipIn * pipOut;

  const titleS = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const titleFade = interpolate(frame, [70, 95], [1, 0.55], ease); // title recedes as editor takes over
  const ctaAppear = 452;
  const ctaS = spring({ frame: frame - ctaAppear, fps, config: { damping: 13 } });

  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 18%, #11151f 0%, #0b0d12 60%, #07090d 100%)" }}>
      {/* parallax dot-grid (drifts slower than the world) */}
      <AbsoluteFill style={{
        backgroundImage: "radial-gradient(circle, #1b2433 1.5px, transparent 1.5px)", backgroundSize: "46px 46px",
        transform: `translateX(${camX * 0.45}px) scale(${camS})`, opacity: 0.6,
      }} />

      {/* WORLD layer (camera-transformed) */}
      <AbsoluteFill style={{ transform: `translate(${camX}px, ${camY}px) scale(${camS})`, transformOrigin: "0 0" }}>
        {/* dense-graph ghost nodes (revealed on zoom-out) */}
        {GHOSTS.map((g, i) => <Ghost key={i} {...g} reveal={ghostReveal} />)}

        {/* wires (world coords) */}
        <svg width="2200" height="1400" style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}>
          <Wire x1={585} y1={470} x2={760} y2={520} appear={172} color="#60a5fa" />{/* image -> video */}
          <Wire x1={585} y1={905} x2={760} y2={600} appear={196} color="#3b82f6" />{/* audio -> video */}
          <Wire x1={1190} y1={560} x2={1360} y2={620} appear={250} color="#34d399" />{/* video -> output */}
        </svg>

        {/* IMAGE GENERATOR node */}
        <div style={{ position: "absolute", left: 120, top: 300 }}>
          <NodeCard x={0} y={0} w={440} appear={96} label="Image Generator" accent="#60a5fa" caption="friendly cartoon bear, cozy living room" ports={["image"]}>
            <div style={{ ...mediaBox, height: 300 }}><img src={rsrc(A.charImg)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          </NodeCard>
        </div>

        {/* AUDIO node */}
        <div style={{ position: "absolute", left: 120, top: 760 }}>
          <NodeCard x={0} y={0} w={440} appear={150} label="Your real voice" accent="#3b82f6" ports={["audio"]}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, height: 92, padding: "0 4px" }}>
              {Array.from({ length: 40 }).map((_, i) => {
                const h = 12 + Math.abs(Math.sin(i * 0.6 + frame * 0.25)) * 66;
                return <div key={i} style={{ flex: 1, height: h, background: "#3b82f6", borderRadius: 3, opacity: 0.85 }} />;
              })}
            </div>
          </NodeCard>
        </div>

        {/* VIDEO GENERATOR node */}
        <div style={{ position: "absolute", left: 760, top: 420 }}>
          <NodeCard x={0} y={0} w={430} appear={206} label="Video Generator · Wan 2.7" accent="#34d399" ports={["video", "image"]}>
            <div style={{ ...mediaBox, height: 360 }}>{frame >= 206 ? <Vid src={rsrc(A.videoClip)} muted loop style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div>
          </NodeCard>
        </div>

        {/* OUTPUT (split-screen) node */}
        <div style={{ position: "absolute", left: 1360, top: 520 }}>
          <NodeCard x={0} y={0} w={430} appear={262} label="Split-screen edit" accent="#f59e0b" ports={["video"]}>
            <div style={{ ...mediaBox, height: 300, display: "flex", flexDirection: "column" }}>
              <div style={{ flex: 1, overflow: "hidden" }}>{frame >= 262 ? <Vid src={rsrc(A.realTop)} muted loop style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div>
              <div style={{ flex: 1, overflow: "hidden" }}>{frame >= 262 ? <Vid src={rsrc(A.videoClip)} muted loop style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div>
            </div>
          </NodeCard>
        </div>
      </AbsoluteFill>

      {/* orbit intro (screen space) */}
      <OrbitIntro end={84} />

      {/* spotlight palette near the image node spot (screen space, before pan) */}
      <Spotlight x={300} y={470} appear={66} dismiss={94} highlight={1} />

      {/* cursor (screen space, follows the action) */}
      <Cursor keys={[
        { at: 0, x: 560, y: 1180 }, { at: 70, x: 330, y: 470 }, { at: 150, x: 360, y: 800 },
        { at: 230, x: 700, y: 560 }, { at: 300, x: 780, y: 640 }, { at: 360, x: 600, y: 720 }, { at: 452, x: 540, y: 980 },
      ]} />

      {/* ── fixed chrome ── */}
      {/* title */}
      <div style={{ position: "absolute", top: 60, left: 0, right: 0, textAlign: "center", opacity: titleS * titleFade, transform: `translateY(${(1 - titleS) * -16}px)`, zIndex: 30 }}>
        <div style={{ color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 62, textShadow: "0 0 30px rgba(96,165,250,0.5)" }}>How it&apos;s made</div>
        <div style={{ color: "#9fb0c9", fontFamily: FONT, fontWeight: 600, fontSize: 30, marginTop: 6 }}>Real voice → AI character</div>
      </div>

      {/* minimap bottom-right */}
      <div style={{ position: "absolute", right: 40, bottom: 60, width: 200, height: 130, borderRadius: 14, background: "rgba(13,17,25,0.8)", border: "1px solid rgba(255,255,255,0.1)", overflow: "hidden", zIndex: 40, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, #232d3d 1px, transparent 1px)", backgroundSize: "12px 12px" }} />
        {[["18%", "26%", "#60a5fa"], ["18%", "62%", "#3b82f6"], ["48%", "40%", "#34d399"], ["76%", "46%", "#f59e0b"]].map((m, i) => (
          <div key={i} style={{ position: "absolute", left: m[0] as string, top: m[1] as string, width: 22, height: 14, borderRadius: 3, background: m[2] as string, opacity: 0.8 }} />
        ))}
        {/* viewport rect that tracks the camera */}
        <div style={{ position: "absolute", top: "20%", height: "56%", width: "34%", border: "1.5px solid rgba(255,255,255,0.7)", borderRadius: 3, left: interpolate(frame, [70, 300, 440], [8, 52, 30], ease) + "%" }} />
      </div>

      {/* Bob narration AUDIO — decoupled from the visual so the full clip (incl. the final word) plays */}
      <Audio src={rsrc(A.presenter)} />
      {/* Bob presenter PiP (glass, MUTED visual) — mounted only for his ~10s narration */}
      {frame < 305 && (
        <div style={{ position: "absolute", bottom: 56, left: 56, width: 420, height: 420, borderRadius: 26, overflow: "hidden", opacity: pip, border: "1px solid rgba(255,255,255,0.16)", boxShadow: "0 16px 50px rgba(0,0,0,0.65)", zIndex: 50 }}>
          <Vid src={rsrc(A.presenter)} muted loop style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      )}

      {/* CTA */}
      {frame >= ctaAppear && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", zIndex: 70 }}>
          <div style={{ transform: `scale(${0.7 + 0.3 * ctaS})`, opacity: ctaS, color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 88, textShadow: "0 6px 34px rgba(0,0,0,0.85)" }}>{cta}</div>
        </AbsoluteFill>
      )}

      {/* music bed added in a follow-up step (sourced track) — see MUSIC_BED below */}
    </AbsoluteFill>
  );
};
