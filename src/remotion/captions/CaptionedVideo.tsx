/**
 * CaptionedVideo — animated caption track over a rendered video.
 * Montserrat, white with a soft shadow (NO outline/border). Words appear ONE BY ONE
 * exactly when spoken (lead-adjusted). Words are packed into rows by MEASURED WIDTH so
 * a row never overflows the frame (2 long words instead of 3 when needed), then paired
 * into TWO-ROW groups for more reading time. Position is a single knob (`yFraction`).
 * `emphasize` italicizes keyword words; default off (uniform).
 */
import React, { useEffect, useState } from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, delayRender, continueRender } from "remotion";

export interface CaptionWord { word: string; start: number; end: number }
export interface CaptionedVideoProps {
  baseVideo: string;            // public-relative path to the rendered video
  words: CaptionWord[];
  yFraction?: number;           // vertical CENTER of the caption block (0..1). Move up/down here. Default 0.43.
  leadSec?: number;             // show each word this many seconds early so it lands ON the spoken word. Default 0.15.
  emphasize?: boolean;          // true → keyword words italic; false → uniform
  keywords?: string[];          // keyword strings to italicize when emphasize is on
  fontSize?: number;            // default 56
  maxRowWidthPx?: number;       // a row may not exceed this width (prevents overflow). Default 900.
  maxRowsPerGroup?: number;     // default 2
  durationInFrames?: number;    // set by the render to match the base video length
  fillColor?: string;           // MEASURED caption fill color (from the reference decode). Default white.
  fontWeight?: number;          // MEASURED caption weight. Default 800.
  animation?: string;           // MEASURED reveal animation: word-pop-in | fade-up | static | ... Default word-pop-in.
}

interface Group { rows: CaptionWord[][]; start: number; end: number }

/** Pack words into rows by estimated width, then pair rows into groups. */
function layoutGroups(words: CaptionWord[], fontSize: number, maxRowWidth: number, rowsPerGroup: number): Group[] {
  const charW = fontSize * 0.58; // Montserrat-ish average glyph width
  const gap = 16;
  const wordWidth = (w: CaptionWord) => Math.max(1, w.word.length) * charW;

  const rows: CaptionWord[][] = [];
  let row: CaptionWord[] = [];
  let rowW = 0;
  const flush = () => { if (row.length) { rows.push(row); row = []; rowW = 0; } };
  for (const w of words) {
    const ww = wordWidth(w);
    if (row.length && rowW + gap + ww > maxRowWidth) flush();
    rowW += (row.length ? gap : 0) + ww;
    row.push(w);
    if (/[.!?]$/.test(w.word)) flush(); // a sentence end closes the row
  }
  flush();

  const groups: Group[] = [];
  for (let i = 0; i < rows.length; i += rowsPerGroup) {
    const grp = rows.slice(i, i + rowsPerGroup);
    const flat = grp.flat();
    groups.push({ rows: grp, start: flat[0].start, end: flat[flat.length - 1].end });
  }
  return groups;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
function isKeyword(word: string, keywords: string[]): boolean {
  const w = norm(word);
  if (w.length < 3) return false;
  if (/\d/.test(w)) return true;
  return keywords.some((k) => { const kn = norm(k); return kn.length >= 3 && (w.includes(kn) || kn.includes(w)); });
}

const useMontserrat = () => {
  const [handle] = useState(() => delayRender("montserrat"));
  useEffect(() => {
    const f = new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")})`, { weight: "100 900" });
    f.load().then((loaded) => { document.fonts.add(loaded); continueRender(handle); }).catch(() => continueRender(handle));
  }, [handle]);
};

export const CaptionedVideo: React.FC<CaptionedVideoProps> = ({
  baseVideo, words, yFraction = 0.43, leadSec = 0.15, emphasize = false, keywords = [], fontSize = 56, maxRowWidthPx = 900, maxRowsPerGroup = 2,
  fillColor = "#FFFFFF", fontWeight = 800, animation = "word-pop-in",
}) => {
  useMontserrat();
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;
  const groups = layoutGroups(words ?? [], fontSize, maxRowWidthPx, maxRowsPerGroup);

  let active: Group | null = null;
  for (let i = 0; i < groups.length; i++) {
    const nextStart = groups[i + 1]?.start ?? groups[i].end + 0.6;
    if (t >= groups[i].start && t < nextStart) { active = groups[i]; break; }
  }

  const shadow = "0 4px 16px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.5)";
  const renderWord = (w: CaptionWord, key: number) => {
    const appear = w.start - leadSec;
    if (t < appear) return null;
    const sinceF = (t - appear) * fps;
    // Reveal animation driven by the MEASURED reference caption animation.
    let o = 1, y = 0;
    if (animation === "static" || animation === "none") { o = 1; y = 0; }
    else if (animation === "fade-up") { o = interpolate(sinceF, [0, 8], [0, 1], { extrapolateRight: "clamp" }); y = interpolate(sinceF, [0, 10], [26, 0], { extrapolateRight: "clamp" }); }
    else { o = interpolate(sinceF, [0, 3], [0, 1], { extrapolateRight: "clamp" }); y = interpolate(sinceF, [0, 4], [14, 0], { extrapolateRight: "clamp" }); } // word-pop-in (default)
    const kw = emphasize && isKeyword(w.word, keywords);
    return (
      <span key={key} style={{ fontSize, fontWeight: kw ? Math.min(900, fontWeight + 100) : fontWeight, color: fillColor, letterSpacing: -1, lineHeight: 1.15, fontStyle: kw ? "italic" : "normal", textShadow: shadow, opacity: o, transform: `translateY(${y}px)`, willChange: "transform, opacity" }}>{w.word}</span>
    );
  };

  return (
    <AbsoluteFill style={{ fontFamily: "Montserrat, sans-serif" }}>
      <OffthreadVideo src={staticFile(baseVideo)} />
      {active ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: height * yFraction, transform: "translateY(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "0 40px" }}>
          {active.rows.map((row, ri) => (
            <div key={ri} style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
              {row.map((w, wi) => renderWord(w, ri * 100 + wi))}
            </div>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
