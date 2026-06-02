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
  presenterSrc?: string;                        // avatar PiP clip
  titleCardLines?: string[];                    // intro card text
  node?: boolean;                               // show the node-graph
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

// ── dark-mode node-graph motion graphic (the Act-2 "how it was made" workflow) ──
const NodeGraph: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // nodes reveal one by one; connectors draw; a prompt types out
  const nodes = [
    { id: "audio", label: "Your real audio", x: 120, y: 120, at: 0 },
    { id: "img", label: "Character image\n(Nano Banana Pro)", x: 120, y: 360, at: 20 },
    { id: "video", label: "Animate + lip-sync\n(Wan 2.7)", x: 540, y: 240, at: 45 },
    { id: "out", label: "Talking AI character", x: 880, y: 240, at: 75 },
  ];
  const edges = [
    { from: "audio", to: "video", at: 60 }, { from: "img", to: "video", at: 60 }, { from: "video", to: "out", at: 90 },
  ];
  const pos: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n) => (pos[n.id] = { x: n.x + 130, y: n.y + 45 }));
  const prompt = "make the character say it...";
  const typed = Math.floor(interpolate(frame, [100, 150], [0, prompt.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));

  return (
    <AbsoluteFill style={{ background: "#0e1116" }}>
      <svg width="1080" height="840" style={{ position: "absolute", top: 0, left: 0 }}>
        {edges.map((e, i) => {
          const a = pos[e.from], b = pos[e.to];
          const p = spring({ frame: frame - e.at, fps, config: { damping: 200 } });
          const mx = (a.x + b.x) / 2;
          const path = `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
          return <path key={i} d={path} stroke="#3b82f6" strokeWidth={4} fill="none" strokeDasharray={600} strokeDashoffset={600 * (1 - p)} opacity={0.9} />;
        })}
      </svg>
      {nodes.map((n) => {
        const s = spring({ frame: frame - n.at, fps, config: { damping: 200 } });
        return (
          <div key={n.id} style={{
            position: "absolute", left: n.x, top: n.y, width: 260, padding: "18px 20px",
            background: "#1b2230", border: "2px solid #2c3a4a", borderRadius: 16,
            color: "#e6edf3", fontFamily: "Inter, Arial, sans-serif", fontWeight: 600, fontSize: 26, lineHeight: 1.25,
            whiteSpace: "pre-line", transform: `scale(${0.6 + 0.4 * s})`, opacity: s, boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
          }}>{n.label}</div>
        );
      })}
      <div style={{
        position: "absolute", left: 120, top: 620, width: 840, padding: "16px 22px",
        background: "#161b22", border: "2px solid #30363d", borderRadius: 12, color: "#9fe2a0",
        fontFamily: "ui-monospace, Menlo, monospace", fontSize: 28, minHeight: 40,
      }}>{prompt.slice(0, typed)}<span style={{ opacity: frame % 30 < 15 ? 1 : 0 }}>|</span></div>
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
        <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: 1280 }}><NodeGraph /></div>
      ) : null}
      {/* presenter PiP bottom */}
      {seg.presenterSrc && (
        <div style={{ position: "absolute", bottom: 60, left: 60, width: 460, height: 460, borderRadius: 24, overflow: "hidden", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", border: "3px solid rgba(255,255,255,0.15)", zIndex: 20 }}>
          <VideoTag src={rsrc(seg.presenterSrc)} loop muted style={fitCover} />
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
