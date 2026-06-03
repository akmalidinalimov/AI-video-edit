import React from "react";
import {
  AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, interpolate, spring, Easing,
  OffthreadVideo, staticFile,
} from "remotion";

/**
 * Act2NodeEditor (v6 — "TIMELINE EDITOR" rebuild) — the Magnific "how it's made" UI scene.
 *
 * ITERATION-4 FIDELITY REBUILD (fix #6 — Act-2 UI layout diverged hard from the reference):
 * the reference's late UI shot is a TIMELINE EDITOR, not a node-graph and not a search/dropdown UI.
 * It shows TWO STACKED PLAYERS (one large preview on top, one smaller below) over a timeline with
 * V1 (video) + A1 (audio waveform) tracks and a vertical PLAYHEAD that scrubs across them.
 *   - REMOVED (fix #6): the search bar, the frosted-glass dropdown menu, the right-edge VERTICAL
 *     player-control strip, the bottom-left "2" step node + curved margin wire, and the bottom-left
 *     minimap — none of these exist in the reference.
 *   - ADDED (fix #6): a large player preview (the generated talking-character clip) + a smaller
 *     stacked player below it; a TIMELINE PANEL with a V1 video track (clip thumbnails) and an A1
 *     audio track (waveform), a ruler, and a moving PLAYHEAD that scrubs L→R (active editing feel).
 *   - KEPT: Magnific wordmark header (top-center), Bob narrator PiP (bottom-left, audio on ~10s),
 *     CTA hold, gentle push-in + drift camera + element entrances.
 *   - MOTION (docs/motion-library): scale-pop (players, timeline panel entrance), slide-in (tracks),
 *     a scrubbing playhead (interpolate sweep), push-in/drift camera, mask-reveal (clip thumbs).
 */

const FONT = "Inter, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, monospace";

// ── Reference accent palette: a PURER BLUE (not teal/cyan). style-fidelity punch-list (2026-06-03)
//    found our teal/cyan UI accent diverged from IMG_6298's purer blue borders/progress/waveforms, and
//    the player border glow was over-pronounced. Shifted toward blue + reduced glow alpha. (Names kept
//    as TEAL* to avoid churn across usages — the VALUES are now blue.) ──
const TEAL = "#5b9cf0";          // primary accent — purer blue
const TEAL_SOFT = "#9cc3fb";     // lighter blue
const TEAL_DIM = "rgba(91,156,240,0.50)";
const TEAL_LINE = "rgba(124,170,245,0.55)";   // thin outline (alpha reduced → less glow)
const TRACK_BG = "rgba(16,22,28,0.9)";

const A = {
  presenter: "uploads/gen/reel2/bob-explainer.mp4",
  charImg: "uploads/gen/reel2/bob-bear.png",
  videoClip: "uploads/gen/reel2/turns/bottom-t1.mp4",  // talking AI character (Wan 2.7) — large player
  realTop: "uploads/gen/reel2/turns/top-t1.mp4",        // real A-roll man (smaller player)
  music: "sfx/act2-bed.mp3",
};
const rsrc = (s: string) => (s.startsWith("http") || s.startsWith("/") || s.includes("://")) ? s : staticFile(s);
// `loop` is honored by OffthreadVideo at runtime (4.x) but absent from its public prop type, so we
// accept it on the wrapper and forward via a typed cast — keeps short preview clips looping without
// a tsc error (and without pulling in <Loop>, which would need an explicit durationInFrames here).
type VidProps = React.ComponentProps<typeof OffthreadVideo> & { loop?: boolean };
const Vid: React.FC<VidProps> = (p) => (
  <OffthreadVideo delayRenderTimeoutInMilliseconds={120000} {...(p as React.ComponentProps<typeof OffthreadVideo>)} />
);
const ease = { easing: Easing.bezier(0.16, 1, 0.3, 1), extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

// ── small inline SVG icons (render-safe; no emoji → no tofu) ──
const Icon: React.FC<{ k: string; s?: number; c?: string }> = ({ k, s = 22, c = TEAL }) => {
  const p = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: c, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (k === "image") return (<svg {...p}><rect x={3} y={4} width={18} height={16} rx={3} /><circle cx={8.5} cy={10} r={1.8} /><path d="M5 18 L10 12 L14 16 L17 13 L20 17" /></svg>);
  if (k === "video") return (<svg {...p}><rect x={3} y={5} width={18} height={14} rx={3} /><path d="M10 9 L15 12 L10 15 Z" fill={c} stroke="none" /></svg>);
  if (k === "audio") return (<svg {...p}><path d="M4 10 v4 M8 7 v10 M12 9 v6 M16 6 v12 M20 10 v4" /></svg>);
  if (k === "play") return (<svg {...p}><path d="M7 5 L19 12 L7 19 Z" fill={c} stroke="none" /></svg>);
  if (k === "pause") return (<svg {...p}><rect x={7} y={5} width={3.5} height={14} rx={1} fill={c} stroke="none" /><rect x={13.5} y={5} width={3.5} height={14} rx={1} fill={c} stroke="none" /></svg>);
  return null;
};

// ── Magnific "M" glyph (small geometric mark for the wordmark) ──
const MGlyph: React.FC<{ s?: number }> = ({ s = 40 }) => (
  <svg width={s} height={s} viewBox="0 0 48 48" fill="none" style={{ display: "block" }}>
    <path d="M7 39 V12 L24 30 L41 12 V39" stroke="#fff" strokeWidth={5.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

const mediaFill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

// content column geometry (single centered column; players + timeline stack vertically)
const COL_X = 90, COL_W = 900;

// ── Audio WAVEFORM bar field (render-safe — deterministic pseudo-random heights). ──
// A1 track content. Bars are static-shaped (a fixed sampled envelope) so the render is
// deterministic; the playhead sweeping across them reads as scrubbing audio.
const WaveBars: React.FC<{ w: number; h: number; played: number }> = ({ w, h, played }) => {
  const N = Math.max(24, Math.floor(w / 9));
  const bars = React.useMemo(() => Array.from({ length: N }, (_, i) => {
    // deterministic envelope: layered sines → speech-like amplitude
    const e = 0.30 + 0.34 * Math.abs(Math.sin(i * 0.45)) + 0.22 * Math.abs(Math.sin(i * 0.13 + 1.1)) + 0.12 * Math.abs(Math.sin(i * 1.7));
    return Math.min(1, e);
  }), [N]);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 3, padding: "0 12px" }}>
      {bars.map((amp, i) => {
        const playedBar = i / N <= played;
        return (
          <div key={i} style={{
            flex: 1, height: `${amp * (h - 18)}px`, borderRadius: 2,
            background: playedBar ? `linear-gradient(${TEAL_SOFT},${TEAL})` : "rgba(120,160,180,0.40)",
          }} />
        );
      })}
    </div>
  );
};

// ── TIMELINE PANEL (fix #6): ruler + V1 video track (clip thumbs) + A1 audio waveform + playhead. ──
const TimelinePanel: React.FC<{ x: number; y: number; w: number; appear: number }> = ({ x, y, w, appear }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (frame < appear - 2) return null;
  const s = spring({ frame: frame - appear, fps, config: { damping: 22, stiffness: 120 } });
  const trackIn = (i: number) => interpolate(frame - appear, [8 + i * 6, 22 + i * 6], [0, 1], ease);

  const PANEL_H = 360;
  const RULER_H = 40, LABEL_W = 70, TRACK_H = 116, TRACK_GAP = 16;
  const tracksX = LABEL_W + 12;
  const tracksW = w - tracksX - 18;

  // PLAYHEAD scrubs L→R across the tracks (active editing feel); loops the visible window.
  const sweep = ((frame - appear) % 210) / 210;     // 0..1 sweep position
  const playheadX = tracksX + sweep * tracksW;

  // V1 video track: 3 clip blocks of varying width (a cut sequence)
  const clips = [{ w: 0.30, label: "char.mp4", k: "video" }, { w: 0.26, label: "real.mov", k: "video" }, { w: 0.40, label: "char.mp4", k: "video" }];

  const trackTop = (i: number) => RULER_H + 10 + i * (TRACK_H + TRACK_GAP);

  return (
    <div style={{
      position: "absolute", left: x, top: y, width: w, height: PANEL_H, borderRadius: 20,
      opacity: s, transform: `translateY(${(1 - s) * 26}px) scale(${0.97 + 0.03 * s})`, transformOrigin: "center top",
      background: "rgba(14,19,25,0.96)", border: `1.5px solid ${TEAL_LINE}`,
      boxShadow: `0 22px 60px rgba(0,0,0,0.55), 0 0 30px ${TEAL_DIM}`, overflow: "hidden", zIndex: 14,
    }}>
      {/* ruler with tick marks + timecodes */}
      <div style={{ position: "absolute", left: tracksX, right: 18, top: 0, height: RULER_H, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} style={{ position: "absolute", left: `${(i / 8) * 100}%`, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div style={{ width: 1, height: i % 2 === 0 ? 14 : 8, background: "rgba(160,190,205,0.45)" }} />
          </div>
        ))}
        {[0, 2, 4, 6, 8].map((i) => (
          <div key={`t${i}`} style={{ position: "absolute", left: `${(i / 8) * 100}%`, top: 4, color: "#7d93a3", fontFamily: MONO, fontSize: 14 }}>0:0{i}</div>
        ))}
      </div>

      {/* V1 — video track (clip thumbnails) */}
      <div style={{ position: "absolute", left: 14, top: trackTop(0) + 38, color: TEAL_SOFT, fontFamily: FONT, fontWeight: 800, fontSize: 22, opacity: trackIn(0) }}>V1</div>
      <div style={{ position: "absolute", left: tracksX, top: trackTop(0), width: tracksW, height: TRACK_H, borderRadius: 10, background: TRACK_BG, opacity: trackIn(0) }}>
        {(() => { let acc = 0; return clips.map((c, i) => {
          const left = acc * tracksW; acc += c.w; const cw = c.w * tracksW - 6;
          return (
            <div key={i} style={{ position: "absolute", left: left + 3, top: 6, width: cw, height: TRACK_H - 12, borderRadius: 8, overflow: "hidden", border: `1px solid ${TEAL_LINE}`, background: "#0c1116" }}>
              {i === 1 ? <img src={rsrc(A.charImg)} style={{ ...mediaFill, filter: "brightness(0.85)" }} />
                       : <Vid src={rsrc(A.videoClip)} muted loop style={{ ...mediaFill, filter: "brightness(0.85)" }} />}
              <div style={{ position: "absolute", left: 8, top: 6, display: "flex", alignItems: "center", gap: 6, color: "#dff2f6", fontFamily: MONO, fontSize: 14, textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>
                <Icon k="video" s={14} c={TEAL_SOFT} />{c.label}
              </div>
            </div>
          );
        }); })()}
      </div>

      {/* A1 — audio track (waveform) */}
      <div style={{ position: "absolute", left: 14, top: trackTop(1) + 38, color: TEAL_SOFT, fontFamily: FONT, fontWeight: 800, fontSize: 22, opacity: trackIn(1) }}>A1</div>
      <div style={{ position: "absolute", left: tracksX, top: trackTop(1), width: tracksW, height: TRACK_H, borderRadius: 10, background: TRACK_BG, opacity: trackIn(1), overflow: "hidden" }}>
        <WaveBars w={tracksW} h={TRACK_H} played={sweep} />
      </div>

      {/* PLAYHEAD — vertical scrubbing line across both tracks */}
      <div style={{ position: "absolute", left: playheadX, top: 0, bottom: 0, width: 2, background: TEAL_SOFT, boxShadow: `0 0 10px ${TEAL}`, opacity: s, zIndex: 20 }}>
        <div style={{ position: "absolute", left: -6, top: 0, width: 14, height: 12, background: TEAL_SOFT, clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
      </div>
    </div>
  );
};

export const Act2NodeEditor: React.FC<{ cta?: string }> = ({ cta = 'Comment "AI"' }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();

  // gentle push-in + slow DRIFT camera (subtle continuous motion, not a static hold).
  const camS = interpolate(frame, [0, 120, 300, 470], [1.05, 1.0, 1.012, 1.022], ease);
  const camX = interpolate(frame, [0, 240, 470], [-8, 6, -4], ease);   // slow horizontal drift
  const camY = interpolate(frame, [0, 120], [12, 0], ease);

  // header (Magnific wordmark + title) springs in top-center
  const headS = spring({ frame: frame - 4, fps, config: { damping: 200 } });

  // presenter PiP — Bob narrates ~10s (300f), fade out for the CTA hold.
  const pipIn = interpolate(frame, [6, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pipOut = interpolate(frame, [288, 302], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pip = pipIn * pipOut;

  // BEATS: large player → smaller player → timeline panel with scrubbing playhead.
  const BIG_AT = 18;
  const SMALL_AT = 40;
  const TIMELINE_AT = 70;

  const ctaAppear = 452;
  const ctaS = spring({ frame: frame - ctaAppear, fps, config: { damping: 13 } });

  // player geometry (two stacked players above the timeline)
  const BIG_Y = 250, BIG_H = 540;
  const SMALL_Y = BIG_Y + BIG_H + 22, SMALL_W = 430, SMALL_H = 250;
  const TIMELINE_Y = SMALL_Y + SMALL_H + 24;

  const bigS = spring({ frame: frame - BIG_AT, fps, config: { damping: 20, stiffness: 120 } });
  const smallS = spring({ frame: frame - SMALL_AT, fps, config: { damping: 20, stiffness: 120 } });
  const bigPlaying = Math.floor(frame / 45) % 2 === 0;   // play/pause toggles → active feel

  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 16%, #0f161d 0%, #0a0f14 60%, #06090c 100%)" }}>
      {/* CONTAINED WORLD (gentle push-in + drift; everything inside moves together) */}
      <AbsoluteFill style={{ transform: `translate(${camX}px, ${camY}px) scale(${camS})`, transformOrigin: "50% 42%" }}>
        {/* ── header: Magnific WORDMARK top-CENTER + title ── */}
        <div style={{ position: "absolute", top: 56, left: 0, right: 0, textAlign: "center", opacity: headS, transform: `translateY(${(1 - headS) * -16}px)`, zIndex: 30 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <MGlyph s={42} />
            <div style={{ color: "#fff", fontFamily: FONT, fontWeight: 800, fontSize: 46, letterSpacing: 0.5 }}>Magnific</div>
          </div>
          <div style={{ color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 58, marginTop: 12, textShadow: `0 0 30px ${TEAL_DIM}` }}>Consistent Voice</div>
          <div style={{ color: "#9fb0c9", fontFamily: FONT, fontWeight: 600, fontSize: 28, marginTop: 6 }}>Seedance 2.0</div>
        </div>

        {/* ── LARGE PLAYER (preview of the generated talking-character clip) ── */}
        <div style={{
          position: "absolute", left: COL_X, top: BIG_Y, width: COL_W, height: BIG_H,
          opacity: bigS, transform: `translateY(${(1 - bigS) * 24}px) scale(${0.96 + 0.04 * bigS})`, transformOrigin: "center top",
          borderRadius: 22, overflow: "hidden",
          background: "#0c1116", border: `1.5px solid ${TEAL_LINE}`,
          boxShadow: `0 26px 70px rgba(0,0,0,0.55), 0 0 34px ${TEAL_DIM}`, zIndex: 12,
        }}>
          <Vid src={rsrc(A.videoClip)} muted loop style={mediaFill} />
          {/* transport pill bottom-center of the large player (play/pause toggles) */}
          <div style={{ position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderRadius: 999, background: "rgba(8,12,16,0.7)", border: `1px solid ${TEAL_LINE}`, backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}>
            <Icon k={bigPlaying ? "pause" : "play"} s={22} c={TEAL_SOFT} />
            <div style={{ width: 180, height: 4, borderRadius: 3, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(frame % 150) / 150 * 100}%`, background: `linear-gradient(90deg,${TEAL},${TEAL_SOFT})` }} />
            </div>
          </div>
          <div style={{ position: "absolute", left: 16, top: 14, color: "#cfeaf0", fontFamily: MONO, fontSize: 18, textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}>Preview · 1080×1080</div>
        </div>

        {/* ── SMALLER STACKED PLAYER (the source / second clip) ── */}
        <div style={{
          position: "absolute", left: COL_X, top: SMALL_Y, width: SMALL_W, height: SMALL_H,
          opacity: smallS, transform: `translateY(${(1 - smallS) * 22}px) scale(${0.96 + 0.04 * smallS})`, transformOrigin: "left top",
          borderRadius: 16, overflow: "hidden",
          background: "#0c1116", border: `1px solid rgba(255,255,255,0.12)`,
          boxShadow: "0 16px 44px rgba(0,0,0,0.5)", zIndex: 11,
        }}>
          <img src={rsrc(A.charImg)} style={mediaFill} />
          <div style={{ position: "absolute", left: 12, top: 10, color: "#cdd9ec", fontFamily: MONO, fontSize: 15, textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}>Source</div>
        </div>
        {/* small label to the right of the smaller player */}
        <div style={{ position: "absolute", left: COL_X + SMALL_W + 24, top: SMALL_Y + 18, width: COL_W - SMALL_W - 24, opacity: smallS, zIndex: 11 }}>
          <div style={{ color: "#e6f1f4", fontFamily: FONT, fontWeight: 700, fontSize: 30 }}>Lip-sync · Wan 2.7</div>
          <div style={{ color: "#8fa3b5", fontFamily: FONT, fontWeight: 500, fontSize: 22, marginTop: 8, lineHeight: 1.35 }}>Real audio drives the generated character on the timeline.</div>
        </div>

        {/* ── TIMELINE PANEL (V1 video + A1 audio waveform + scrubbing playhead) ── */}
        <TimelinePanel x={COL_X} y={TIMELINE_Y} w={COL_W} appear={TIMELINE_AT} />
      </AbsoluteFill>

      {/* Bob narration AUDIO — decoupled from the visual so the full clip (incl. final word) plays */}
      <Audio src={rsrc(A.presenter)} />
      {/* Bob presenter PiP (glass, MUTED visual) — the NARRATOR avatar (bottom-LEFT). Mounted for his ~10s. */}
      {frame < 305 && (
        <div style={{ position: "absolute", bottom: 56, left: 56, width: 280, height: 280, borderRadius: 24, overflow: "hidden", opacity: pip, border: `1px solid ${TEAL_LINE}`, boxShadow: "0 16px 50px rgba(0,0,0,0.65)", zIndex: 50 }}>
          <Vid src={rsrc(A.presenter)} muted loop style={mediaFill} />
        </div>
      )}

      {/* CTA */}
      {frame >= ctaAppear && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", zIndex: 70 }}>
          <div style={{ transform: `scale(${0.7 + 0.3 * ctaS})`, opacity: ctaS, color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 88, textShadow: "0 6px 34px rgba(0,0,0,0.85)" }}>{cta}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
