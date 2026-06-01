/**
 * trim-validator.mjs — SENTENCE-anchored trim snapping (PURE, no ffmpeg calls).
 *
 * PROBLEM IT SOLVES:
 *   Snapping each cut to the NEAREST word within a window is wrong: the nearest
 *   word can belong to a NEIGHBOUR sentence, so a segment loses its last word,
 *   starts mid-sentence, or bleeds the next sentence's first word in. We instead
 *   anchor each segment to its INTENDED sentence (the one the narrative analyzer
 *   selected) and cut at THAT sentence's first/last word — guaranteeing the
 *   complete sentence, no more, no less.
 *
 * HOW THE INTENDED SENTENCE IS FOUND (deterministic):
 *   `segment.id` is "C{clip}_S{n}" where n indexes EXACTLY into
 *   clip_{clip}_transcription.json.sentences[n] (see multi-aroll-stage2.mjs).
 *   This disambiguates false-start retakes (an incomplete duplicate sentence has
 *   a different index). Fuzzy text match is a fallback only.
 *
 * SILENCE AT THE CUTS:
 *   sourceStart = the sentence's FIRST word onset (minus PREROLL); sourceEnd =
 *   the LAST word offset (plus TAIL). Optional acoustic refiners (injected by the
 *   orchestrator) then trim residual leading silence (acousticOnset) and trailing
 *   silence (acousticOffset) by measuring real speech energy — never crossing
 *   into the first/last word.
 *
 * SAME-CLIP CONTIGUOUS RUNS:
 *   Consecutive segments from the same clip whose sentences abut (seg[i].sourceEnd
 *   ~= seg[i+1].sourceStart) are ONE continuous take. We snap only the run's OUTER
 *   edges and keep the internal boundary identical (mid-take continuous speech —
 *   trimming it would sound unnatural and could open a gap). The renderer merges
 *   such runs into one circle overlay.
 *
 * GUARANTEES:
 *   - each segment contains its intended sentence(s) COMPLETE (no cut/overlap)
 *   - cuts land on word boundaries; residual silence trimmed by acoustic refiners
 *   - same-clip runs stay contiguous; segments play back-to-back (zero-gap)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = process.cwd();
const STAGE1_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");

// Tolerances (seconds)
export const SNAP_WINDOW = 1.2;   // fallback: how far to look for a word boundary
export const PREROLL = 0.04;      // tiny lead kept before the first word onset
export const TAIL = 0.06;         // tiny tail kept after the last word offset
// Same-clip adjacent sentences sit within a natural inter-sentence PAUSE of each
// other (MMS reveals real ~0.3s pauses Gemini hid by abutting them). Treat them as
// ONE continuous take (kept merged, pause included → continuous shot, no jump cut,
// no split-overlay blank-circle risk). 0.6s comfortably covers a natural pause
// without merging genuinely separate takes.
export const CONTIG_EPS = 0.6;    // |prev.sourceEnd - cur.sourceStart| under this = contiguous same-clip
export const SENT_EPS = 0.05;     // word-in-sentence inclusion slack

/** Load a clip's WORD list (clip_N_words.json); [] if missing. */
export function loadWordMap(clipIndex) {
  const p = path.join(STAGE1_DIR, `clip_${clipIndex}_words.json`);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Array.isArray(j.words) ? j.words : [];
  } catch {
    return [];
  }
}

/** Load full transcription (words + sentences) for a clip; null if missing. */
export function loadTranscription(clipIndex) {
  const p = path.join(STAGE1_DIR, `clip_${clipIndex}_transcription.json`);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      words: Array.isArray(j.words) ? j.words : [],
      sentences: Array.isArray(j.sentences) ? j.sentences : [],
    };
  } catch {
    return null;
  }
}

/** Normalize text to comparable tokens (NFC, lowercase, strip punct + apostrophe variants). */
export function normalizeTokens(text) {
  if (!text) return [];
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[''`ʻʼ]/g, "")
    .replace(/[.,!?;:()"«»…–—-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Resolve the INTENDED sentence(s) for a segment. Returns the union span when the
 * segment's text covers multiple consecutive sentence entries.
 *   -> { startSentence, endSentence, source: "id"|"fuzzy", score } | null
 */
export function resolveIntendedSentence(seg, transcription) {
  if (!transcription || !transcription.sentences.length) return null;
  const sentences = transcription.sentences;

  // PRIMARY: id "C{clip}_S{n}" -> sentences[n].
  const m = /^C(\d+)_S(\d+)$/.exec(seg.id || "");
  let startIdx = null;
  if (m && Number(m[1]) === seg.sourceClipIndex) {
    const n = Number(m[2]);
    if (n >= 0 && n < sentences.length) startIdx = n;
  }

  // FALLBACK: fuzzy — the sentence overlapping the rough span with best token
  // overlap, preferring is_complete:true.
  let source = "id", score = 1;
  if (startIdx === null) {
    const segTokens = new Set(normalizeTokens(seg.text));
    let best = null, bestScore = 0;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const overlap = (s.start <= (seg.sourceEnd ?? Infinity) && s.end >= (seg.sourceStart ?? -Infinity));
      if (!overlap) continue;
      const st = normalizeTokens(s.text);
      const inter = st.filter(t => segTokens.has(t)).length;
      const sc = st.length ? inter / st.length : 0;
      const adj = sc + (s.is_complete !== false ? 0.05 : 0);
      if (adj > bestScore) { bestScore = adj; best = i; }
    }
    if (best === null) return null;
    startIdx = best; source = "fuzzy"; score = bestScore;
  }

  // Extend forward while the segment's text still contains the next sentence's
  // tokens (handles a segment that spans multiple sentence entries).
  const segSet = new Set(normalizeTokens(seg.text));
  let endIdx = startIdx;
  while (endIdx + 1 < sentences.length) {
    const nextTokens = normalizeTokens(sentences[endIdx + 1].text);
    if (!nextTokens.length) break;
    const covered = nextTokens.filter(t => segSet.has(t)).length / nextTokens.length;
    if (covered >= 0.7) endIdx++;
    else break;
  }

  return { startSentence: sentences[startIdx], endSentence: sentences[endIdx], source, score };
}

/**
 * First word onset / last word offset for a sentence span, re-derived from the
 * WORD list so bounds sit on real word edges.
 *   -> { firstOnset, lastOffset, firstWord, lastWord, wordCount } | null
 */
export function sentenceWordSpan(words, startSentence, endSentence = startSentence) {
  const lo = startSentence.start - SENT_EPS;
  const hi = endSentence.end + SENT_EPS;
  const inSpan = words.filter(w => w.start >= lo && w.end <= hi);
  if (!inSpan.length) return null;
  return {
    firstOnset: inSpan[0].start,
    lastOffset: inSpan[inSpan.length - 1].end,
    firstWord: inSpan[0].word,
    lastWord: inSpan[inSpan.length - 1].word,
    wordCount: inSpan.length,
  };
}

/** Fallback: onset of the word whose START is nearest `t` (within SNAP_WINDOW). */
export function snapOnset(words, t) {
  let best = null, bestDist = SNAP_WINDOW;
  for (const w of words) {
    const d = Math.abs(w.start - t);
    if (d <= bestDist) { bestDist = d; best = w.start; }
  }
  if (best === null) return { value: t, snapped: false, wordStart: null };
  return { value: Math.max(0, best - PREROLL), snapped: true, wordStart: best };
}

/** Fallback: offset of the word whose END is nearest `t` (within SNAP_WINDOW). */
export function snapOffset(words, t) {
  let best = null, bestDist = SNAP_WINDOW;
  for (const w of words) {
    const d = Math.abs(w.end - t);
    if (d <= bestDist) { bestDist = d; best = w.end; }
  }
  if (best === null) return { value: t, snapped: false, wordEnd: null };
  return { value: best + TAIL, snapped: true, wordEnd: best };
}

/**
 * Validate & re-emit a clean timeline with SENTENCE-anchored trims and a
 * contiguous, zero-gap timeline. Pure unless acoustic refiners are injected.
 *
 * @param opts.acousticOnset  (clipIndex, clipPath, wordStart, snappedStart) => number|null
 *   Trim residual leading silence after the first word onset (never into the word).
 * @param opts.acousticOffset (clipIndex, clipPath, wordEnd, snappedEnd) => number|null
 *   Trim residual trailing silence before the chosen end (never into the last word).
 */
export function validateTrims(timeline, opts = {}) {
  const segments = timeline.segments.map(s => ({ ...s }));

  // Contiguity is a property of the ORIGINAL (input) timeline — whether two
  // same-clip segments abut in the source. Capture the input values up front so
  // detection isn't corrupted as we mutate sourceStart/sourceEnd below (e.g. when
  // alignment moves a boundary, the prev.end vs next.start comparison would
  // otherwise mix a new value with an old one).
  const origStart = segments.map(s => s.sourceStart);
  const origEnd = segments.map(s => s.sourceEnd);
  const isRunStart = (i) => {
    if (i === 0) return true;
    return !(segments[i - 1].sourceClipIndex === segments[i].sourceClipIndex &&
             Math.abs(origEnd[i - 1] - origStart[i]) < CONTIG_EPS);
  };
  const isRunEnd = (i) => {
    if (i === segments.length - 1) return true;
    return !(segments[i].sourceClipIndex === segments[i + 1].sourceClipIndex &&
             Math.abs(origEnd[i] - origStart[i + 1]) < CONTIG_EPS);
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const tr = loadTranscription(seg.sourceClipIndex);
    const words = tr ? tr.words : loadWordMap(seg.sourceClipIndex);
    const notes = [];

    // Resolve the intended sentence span for this segment.
    const resolved = tr ? resolveIntendedSentence(seg, tr) : null;
    const span = resolved ? sentenceWordSpan(words, resolved.startSentence, resolved.endSentence) : null;
    if (resolved && resolved.source === "fuzzy" && resolved.score < 0.6) seg._trimWarn = `low fuzzy match ${resolved.score.toFixed(2)}`;
    seg._sentenceSource = resolved ? resolved.source : "none";

    // -- START --
    if (isRunStart(i)) {
      let start, wordStart;
      if (span) {
        wordStart = span.firstOnset;
        start = Math.max(0, span.firstOnset - PREROLL);
        notes.push(`start ${seg.sourceStart.toFixed(3)}->${start.toFixed(3)} (sentence "${span.firstWord}" onset)`);
      } else {
        const r = snapOnset(words, seg.sourceStart);
        wordStart = r.wordStart; start = r.value;
        if (r.snapped) notes.push(`start ${seg.sourceStart.toFixed(3)}->${start.toFixed(3)} (word onset, fallback)`);
      }
      if (wordStart != null && typeof opts.acousticOnset === "function") {
        const refined = opts.acousticOnset(seg.sourceClipIndex, seg.sourceClipPath, wordStart, start);
        if (typeof refined === "number" && isFinite(refined) && refined > start + 0.01) {
          notes.push(`start ${start.toFixed(3)}->${refined.toFixed(3)} (acoustic onset)`);
          start = refined;
        }
      }
      seg.sourceStart = start;
    } else {
      seg.sourceStart = segments[i - 1].sourceEnd; // contiguous internal boundary
      notes.push(`start = prev internal boundary ${seg.sourceStart.toFixed(3)} (same-clip run)`);
    }

    // -- END --
    if (isRunEnd(i)) {
      let end, wordEnd;
      if (span) {
        wordEnd = span.lastOffset;
        end = span.lastOffset + TAIL;
        notes.push(`end ${seg.sourceEnd.toFixed(3)}->${end.toFixed(3)} (sentence "${span.lastWord}" offset)`);
      } else {
        const r = snapOffset(words, seg.sourceEnd);
        wordEnd = r.wordEnd; end = r.value;
        if (r.snapped) notes.push(`end ${seg.sourceEnd.toFixed(3)}->${end.toFixed(3)} (word offset, fallback)`);
      }
      if (wordEnd != null && typeof opts.acousticOffset === "function") {
        const refined = opts.acousticOffset(seg.sourceClipIndex, seg.sourceClipPath, wordEnd, end);
        // Apply when it trims (refined earlier than the word-based end) AND keeps a
        // sane segment length. acousticOffset returns the TRUE speech end, so it may
        // legitimately fall well below the (Gemini-inflated) last word end.
        if (typeof refined === "number" && isFinite(refined) && refined < end - 0.01 && refined > seg.sourceStart + 0.2) {
          notes.push(`end ${end.toFixed(3)}->${refined.toFixed(3)} (acoustic offset)`);
          end = refined;
        }
      }
      seg.sourceEnd = end;
    } else {
      // Internal boundary of a same-clip run: cut at the intended sentence's last
      // word offset (mid-take continuous speech; the next segment continues here).
      if (span) {
        seg.sourceEnd = span.lastOffset;
        notes.push(`end ${seg.sourceEnd.toFixed(3)} (run internal: sentence "${span.lastWord}" offset)`);
      } else {
        notes.push(`end ${seg.sourceEnd.toFixed(3)} kept (same-clip internal boundary)`);
      }
    }

    // SAFETY-NET extend (boundary-guard.mjs): if a boundary word was found clipped
    // in the rendered OUTPUT, push the run's outer edge out a little (capped) to
    // recover it. Only applied to a run's outer edges; internal boundaries stay put.
    const ex = opts.extendBySeg && opts.extendBySeg[i];
    if (ex) {
      if (isRunStart(i) && ex.startExtra) {
        seg.sourceStart = Math.max(0, seg.sourceStart - Math.min(ex.startExtra, 0.6));
        notes.push(`start extended -${Math.min(ex.startExtra, 0.6).toFixed(2)}s (boundary-guard)`);
      }
      if (isRunEnd(i) && ex.endExtra) {
        seg.sourceEnd = seg.sourceEnd + Math.min(ex.endExtra, 0.6);
        notes.push(`end extended +${Math.min(ex.endExtra, 0.6).toFixed(2)}s (boundary-guard)`);
      }
    }

    seg.sourceStart = Math.round(seg.sourceStart * 1000) / 1000;
    seg.sourceEnd = Math.round(seg.sourceEnd * 1000) / 1000;
    seg.sourceDuration = Math.round((seg.sourceEnd - seg.sourceStart) * 1000) / 1000;
    seg._trimNote = notes.join("; ") || "no snap needed";
  }

  // Contiguous timeline (zero gaps): each segment starts where prev ended.
  let cursor = 0;
  for (const seg of segments) {
    seg.timelineStart = Math.round(cursor * 1000) / 1000;
    cursor += seg.sourceDuration;
    seg.timelineEnd = Math.round(cursor * 1000) / 1000;
  }

  return {
    ...timeline,
    totalDuration: Math.round(cursor * 1000) / 1000,
    segments,
    _validatedBy: "trim-validator.mjs (sentence-anchored, contiguous)",
  };
}

// -- Run as a script: read rough timeline, validate, write clean-timeline.json --
function main() {
  const stage2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
  const tlPath = path.join(stage2, "clean-timeline.json");
  const prePath = path.join(stage2, "clean-timeline.pre-validate.json");
  const srcPath = fs.existsSync(prePath) ? prePath : tlPath;
  const timeline = JSON.parse(fs.readFileSync(srcPath, "utf-8"));

  console.log("=== TRIM VALIDATOR — SENTENCE-anchored ===\n");
  console.log(`  Source boundaries: ${path.basename(srcPath)}`);
  console.log(`  Segments: ${timeline.segments.length}\n`);

  const validated = validateTrims(timeline);

  for (let i = 0; i < validated.segments.length; i++) {
    const s = validated.segments[i];
    console.log(`  Seg ${i} (clip ${s.sourceClipIndex}, ${s.id}, src=${s._sentenceSource}): ` +
      `src ${s.sourceStart.toFixed(3)}-${s.sourceEnd.toFixed(3)} (${s.sourceDuration.toFixed(3)}s) -> tl ${s.timelineStart.toFixed(3)}-${s.timelineEnd.toFixed(3)}`);
    console.log(`        ${s._trimNote}`);
    if (s._trimWarn) console.log(`        WARN ${s._trimWarn}`);
  }
  console.log(`\n  Total duration: ${validated.totalDuration.toFixed(3)}s (was ${timeline.totalDuration.toFixed(3)}s)`);

  fs.writeFileSync(tlPath, JSON.stringify(validated, null, 2));
  console.log(`  Written: ${tlPath}`);
  console.log("\n  TRIM VALIDATION COMPLETE\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
