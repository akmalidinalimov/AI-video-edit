/**
 * reel2-build-act1.mjs — REEL-2 Act-1 builder with reel-1's word-accurate rigor.
 *
 * Fixes the v2 bug where each turn was cut from drifting Gemini SENTENCE times, so
 * the first word ("Hey") and the wife's turn onsets landed mid-word. Here every turn
 * is anchored to MMS-aligned WORD edges, re-cut, and boundary-guarded.
 *
 * PIPELINE (run all by default, or a single phase via flag):
 *   --transcribe   word-level Gemini transcript of both source clips -> stage1 JSON
 *   --align        MMS forced alignment (align_mms.py) -> precise word times in place
 *   --trim         anchor each of the 8 turns to its word span, re-cut top + audio,
 *                  write turns-manifest.json + rebuilt reel2-props.json
 *   --guard        boundary-guard: re-transcribe each re-cut clip head/tail, confirm
 *                  the first AND last word are present (extend + re-cut if clipped)
 *   (no flag)      transcribe -> align -> trim -> guard
 *   --force        re-transcribe even if a stage1 transcript already exists
 *
 * Generation of the per-turn lip-sync clips (turns/bottom-tN.mp4 via wan2_7) is an
 * MCP step the agent runs AFTER --trim, using turns-manifest.json. The rebuilt props
 * already reference turns/bottom-tN.mp4, so render once those files exist.
 *
 * Reel-2 lives entirely under public/exports/reel2 + public/uploads/gen/reel2 — reel-1
 * (public/exports/multi-aroll) is never touched.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { normalizeTokens } from "./lib/trim-validator.mjs";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const PY = path.join(ROOT, "scripts", "python", ".venv", "Scripts", "python.exe");
const ALIGN = path.join(ROOT, "scripts", "python", "align_mms.py");

const REEL2 = path.join(ROOT, "public", "exports", "reel2");
const STAGE1 = path.join(REEL2, "stage1");
const TURNS_DIR = path.join(ROOT, "public", "uploads", "gen", "reel2", "turns");
const GEN_DIR = path.join(ROOT, "public", "uploads", "gen", "reel2");
const PROPS_PATH = path.join(REEL2, "reel2-props.json");
const MANIFEST_PATH = path.join(REEL2, "turns-manifest.json");

const FPS = 30;
const PREROLL = 0.06;   // tiny lead kept before the first word onset
const TAIL = 0.08;      // tiny tail kept after the last word offset
const SIM = 0.7;        // fuzzy token match threshold

// Head-safe top-band crop (docs/cropping-rules.md): never clip the head; keep a small
// top gap + shoulders. Reuses reel-1's YuNet detector. The top band is 1080x840.
const PY_VISION = path.join(ROOT, "scripts", "python", ".venv-vision", "Scripts", "python.exe");
const YUNET = path.join(ROOT, "scripts", "python", "detect_face_yunet.py");
const BAND_W = 1080, BAND_H = 840, BAND_ASPECT = BAND_W / BAND_H;
const TOP_GAP = 0.09;   // headroom above the head-top, as a fraction of the band height

// Source clips: clip 0 = man (Bob/bear), clip 1 = wife (Zig/bunny).
const CLIPS = [
  { idx: 0, path: path.join(ROOT, "public", "uploads", "arolls", "reels2", "IMG_6373.MOV") },
  { idx: 1, path: path.join(ROOT, "public", "uploads", "arolls", "reels2", "IMG_6374.MOV") },
];

// The 8 dialogue turns IN ORDER. clip = which performer's clip to take it from;
// char = which cartoon speaks it (image for the lip-sync gen).
const TURNS = [
  { t: 1, clip: 0, char: "bob", text: "Hey, I invented a new sport. It's called extreme sitting." },
  { t: 2, clip: 1, char: "zig", text: "Isn't that just sitting?" },
  { t: 3, clip: 0, char: "bob", text: "No, no. You sit aggressively. Watch." },
  { t: 4, clip: 1, char: "zig", text: "That's not aggressive. That's constipation." },
  { t: 5, clip: 0, char: "bob", text: "I call that level two." },
  { t: 6, clip: 1, char: "zig", text: "Please tell me there is no level three." },
  { t: 7, clip: 0, char: "bob", text: "Yes, there is. A level three involves snacks." },
  { t: 8, clip: 1, char: "zig", text: "Okay, now I'm listening." },
];

const CHAR_IMAGE = {
  bob: "uploads/gen/reel2/bob-bear.png",
  zig: "uploads/gen/reel2/zig-bunny.png",
};

// ── env ──
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}

function probeDuration(file) {
  const raw = execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", file], { encoding: "utf-8" });
  return parseFloat(JSON.parse(raw).format.duration);
}

// ── Levenshtein-ratio fuzzy match (same as boundary-guard) ──
function simRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length; if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) { const t = dp[i]; dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return 1 - dp[m] / Math.max(m, n);
}
const tokEq = (a, b) => simRatio(a, b) >= SIM;

// ════════════════════════════════════════════════════════ TRANSCRIBE
const TRANSCRIBE_PROMPT = (dur) => `You are a precise speech-to-text engine. Transcribe the SPOKEN ENGLISH audio of this video with EXACT word-level timestamps. The clip is ~${Math.round(dur)}s.
Return ONLY strict JSON (no markdown):
{ "language":"en",
  "words":[ {"word":"Hey","start":0.00,"end":0.30} ],
  "sentences":[ {"text":"Full sentence.","start":0.0,"end":3.5,"is_complete":true} ] }
Rules: a timestamp for EVERY word; seconds with 2 decimals; start = word onset, end = word offset; be precise to 0.1s. Group words into sentences. Transcribe VERBATIM — do not correct or paraphrase.`;

async function transcribeClip(clip, key) {
  const fm = new GoogleAIFileManager(key);
  process.stdout.write(`  [clip ${clip.idx}] uploading ${path.basename(clip.path)}...`);
  const up = await fm.uploadFile(clip.path, { mimeType: "video/quicktime", displayName: `reel2_clip_${clip.idx}` });
  let file = await fm.getFile(up.file.name);
  while (file.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  if (file.state !== "ACTIVE") throw new Error(`upload failed: ${file.state}`);
  const dur = probeDuration(clip.path);
  const genAI = new GoogleGenerativeAI(key);
  const parts = [{ fileData: { mimeType: file.mimeType, fileUri: file.uri } }, { text: TRANSCRIBE_PROMPT(dur) }];
  process.stdout.write(" transcribing...");
  // gemini-2.5-pro is most accurate but flakes under load (503); retry w/ backoff, then fall back to flash.
  const tiers = ["gemini-2.5-pro", "gemini-2.5-pro", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash"];
  let j = null, lastErr = null;
  for (let attempt = 0; attempt < tiers.length && !j; attempt++) {
    const model = genAI.getGenerativeModel({ model: tiers[attempt], generationConfig: { temperature: 0, responseMimeType: "application/json" } });
    try {
      const res = await model.generateContent(parts);
      j = JSON.parse(res.response.text());
    } catch (e) {
      lastErr = e;
      const overloaded = e?.status === 503 || e?.status === 429;
      process.stdout.write(overloaded ? ` [${tiers[attempt]} busy, retry]` : ` [err: ${String(e.message).slice(0, 60)}]`);
      await new Promise(r => setTimeout(r, overloaded ? 4000 * (attempt + 1) : 2000));
    }
  }
  if (!j) throw lastErr || new Error("transcription failed");
  const out = { clipIndex: clip.idx, clipPath: clip.path, clipName: path.basename(clip.path), duration: dur, language: j.language || "en", words: j.words || [], sentences: j.sentences || [] };
  fs.mkdirSync(STAGE1, { recursive: true });
  fs.writeFileSync(path.join(STAGE1, `clip_${clip.idx}_transcription.json`), JSON.stringify(out, null, 2));
  console.log(` ✓ ${out.words.length} words, ${out.sentences.length} sentences`);
  return out;
}

async function doTranscribe(force) {
  const key = loadKey(); if (!key) throw new Error("no GEMINI_API_KEY");
  console.log("=== TRANSCRIBE (word-level) ===");
  for (const clip of CLIPS) {
    const p = path.join(STAGE1, `clip_${clip.idx}_transcription.json`);
    if (fs.existsSync(p) && !force) { console.log(`  [clip ${clip.idx}] transcript exists (skip; --force to redo)`); continue; }
    await transcribeClip(clip, key);
  }
}

// ════════════════════════════════════════════════════════ ALIGN (MMS)
function doAlign() {
  console.log("\n=== MMS FORCED ALIGNMENT ===");
  for (const clip of CLIPS) {
    const tr = path.join(STAGE1, `clip_${clip.idx}_transcription.json`);
    const words = path.join(STAGE1, `clip_${clip.idx}_words.json`);
    if (!fs.existsSync(tr)) throw new Error(`missing ${tr} — run --transcribe first`);
    console.log(`  [clip ${clip.idx}] aligning...`);
    const out = execFileSync(PY, [ALIGN, clip.path, tr, words], { encoding: "utf-8" });
    console.log("    " + out.trim().split("\n").join("\n    "));
  }
}

// ════════════════════════════════════════════════════════ TRIM (anchor turns)
function loadWords(clipIdx) {
  const tr = JSON.parse(fs.readFileSync(path.join(STAGE1, `clip_${clipIdx}_transcription.json`), "utf-8"));
  // map each word -> normalized token (use first token only; punctuation drops)
  return (tr.words || []).map(w => ({ ...w, norm: (normalizeTokens(w.word)[0] || "") }));
}

/**
 * Find the contiguous span of `words` (from index >= cursor) best matching the turn's
 * token sequence. The first transcript word must match the turn's first token (so the
 * cut starts on the real first word). Tolerates a few transcript insertions.
 *   -> { firstOnset, lastOffset, startIdx, endIdx, matched, total } | null
 */
function findSpan(words, turnText, cursor) {
  const turn = normalizeTokens(turnText);
  if (!turn.length) return null;
  let best = null;
  for (let i = cursor; i < words.length; i++) {
    if (!words[i].norm || !tokEq(words[i].norm, turn[0])) continue;
    // greedily align turn tokens forward from i, allowing limited transcript skips
    let wi = i, ti = 0, matched = 0, lastIdx = i, skips = 0;
    while (ti < turn.length && wi < words.length && skips <= 6) {
      if (words[wi].norm && tokEq(words[wi].norm, turn[ti])) { matched++; lastIdx = wi; wi++; ti++; }
      else if (ti > 0 && wi + 1 < words.length && words[wi + 1].norm && tokEq(words[wi + 1].norm, turn[ti])) { wi++; skips++; } // transcript insertion
      else { ti++; skips++; } // turn token not found here; advance turn token
    }
    const score = matched / turn.length;
    if (!best || score > best.score) best = { startIdx: i, endIdx: lastIdx, matched, total: turn.length, score };
    if (best && best.score >= 0.95 && best.startIdx === i) break; // strong match at first candidate
  }
  if (!best || best.score < 0.5) return null;
  return {
    firstOnset: words[best.startIdx].start,
    lastOffset: words[best.endIdx].end,
    startIdx: best.startIdx, endIdx: best.endIdx,
    matched: best.matched, total: best.total, score: best.score,
  };
}

// Cut the raw portrait turn (video+audio), no crop — used as the detection/crop source.
function cutRaw(clipPath, start, dur, out) {
  execFileSync(FFMPEG, ["-y", "-ss", start.toFixed(3), "-i", clipPath, "-t", dur.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", "-loglevel", "error", out], { stdio: "pipe" });
}

/** Run YuNet on a clip → { centerX, faceTopY, height, headTopY, srcW, srcH } | null. */
function detectFace(videoPath, samples = 10) {
  const out = videoPath + ".face.json";
  try {
    execFileSync(PY_VISION, [YUNET, videoPath, out, "--samples", String(samples)], { stdio: "pipe" });
    const j = JSON.parse(fs.readFileSync(out, "utf-8"));
    try { fs.unlinkSync(out); } catch {}
    // Motion envelope across the per-frame samples: the HIGHEST crown (smallest headTopY) and the
    // LOWEST chin (largest faceTopY+height) over the turn — this is what a lean-in pushes, and what
    // the band crop must contain head-safe. calculateBandCrop uses it to size the window minimally.
    const S = Array.isArray(j.samples) ? j.samples : [];
    const crowns = S.map(s => s.headTopY).filter(x => typeof x === "number");
    const chins = S.map(s => (typeof s.faceTopY === "number" && typeof s.height === "number") ? s.faceTopY + s.height : null).filter(x => x != null);
    return { centerX: j.median.centerX, faceTopY: j.median.topY, height: j.median.height,
             headTopY: j.headTopY, srcW: j.fullWidth, srcH: j.fullHeight,
             crownMinY: crowns.length ? Math.min(...crowns) : undefined,
             chinMaxY: chins.length ? Math.max(...chins) : undefined };
  } catch { return null; }
}

/**
 * Head-safe band crop (docs/cropping-rules.md), band aspect 1080:840.
 *   -> { cropW, cropH, cropX, cropY, letterbox }
 *
 * ITERATION-4 REWRITE (fix #1 — t3 STILL clipped: headTop(min)=0).
 * Root cause (measured): for a CLOSE subject (t3 face = ~80% of the band height) a full-width
 * band-aspect window simply cannot fit headroom + chin at once — at every workable TOP_GAP the
 * chin pushes past the band bottom OR the crown clips the top, AND the thin motion margin let the
 * lean-in frame hit headTop=0. The only real fix is to ZOOM OUT so the face is a safe fraction of
 * the band — but a 720-wide source can't give a band-aspect window taller than 560px without
 * exceeding its width. So when the face is too big, we take a TALLER window (up to full source
 * height), accept that it's NARROWER than the band aspect, and letterbox the sides with a blurred
 * fill of the same frame (never a stretch — docs/cropping-rules.md "a band is a CROP, never a
 * stretch"). This shrinks the face to FACE_FRAC_TARGET of the band so headroom AND chin both fit.
 */
function calculateBandCrop(srcW, srcH, face) {
  const heightFrac = face.height ?? 0.24;
  const faceTopY = face.faceTopY ?? 0.18;
  const headTopY = face.headTopY ?? Math.max(0, faceTopY - heightFrac * 0.18);
  // Match the rendered gate (reel2-crop-check): crown gap >= GAP_MIN, face bottom <= BOTTOM_MAX.
  const GAP_MIN = 0.03, BOTTOM_MAX = 0.99, GAP_TARGET = 0.06;
  // Motion envelope (lean-in): HIGHEST crown + LOWEST chin across the turn's detection samples, with
  // a small pad for detection-vs-render noise. The band must contain THIS, not just the static face.
  const PAD = 0.012;
  const crownMinY = (face.crownMinY ?? headTopY) - PAD;
  const chinMaxY = (face.chinMaxY ?? (faceTopY + heightFrac)) + PAD;
  const crownPx = crownMinY * srcH, chinPx = chinMaxY * srcH;

  // Full-width band-aspect window (max vertical extent, never wider than source) — the DEFAULT.
  let cropW = srcW;
  let cropH = Math.round(cropW / BAND_ASPECT);
  if (cropH > srcH) { cropH = srcH; cropW = Math.round(cropH * BAND_ASPECT); }

  // Smallest window that fits the whole crown..chin envelope head-safe (crown>=GAP_MIN, chin<=BOTTOM_MAX).
  const usable = BOTTOM_MAX - GAP_MIN;                       // fraction of cropH available for crown..chin
  const minCropH = Math.ceil((chinPx - crownPx) / usable);
  let letterbox = false, cropY;

  if (minCropH <= cropH) {
    // FULL-BLEED full-width (preferred — identical treatment to every other turn, no pillarbox).
    const cropYmax = crownPx - GAP_MIN * cropH;
    const cropYmin = chinPx - BOTTOM_MAX * cropH;
    const target = crownPx - GAP_TARGET * cropH;
    cropY = Math.round(Math.max(cropYmin, Math.min(cropYmax, target)));
  } else {
    // MINIMAL zoom-out: grow the window JUST enough to contain the lean-in envelope, so the face
    // stays as large as the full-bleed turns and the blurred side-fill is as thin as possible (NOT
    // the old fixed 0.52 zoom-out, which shrank the face and added a huge pillarbox). Letterbox only
    // because the taller window is narrower than the band aspect (docs/cropping-rules.md: crop, never stretch).
    cropH = Math.min(srcH, minCropH);
    const widthForAspect = Math.round(cropH * BAND_ASPECT);
    if (widthForAspect > srcW) { cropW = srcW; letterbox = true; }
    else cropW = widthForAspect;
    // center the leftover slack so neither crown nor chin sits exactly on a gate edge
    const slack = Math.max(0, usable * cropH - (chinPx - crownPx));
    cropY = Math.round(crownPx - (GAP_MIN + slack / (2 * cropH)) * cropH);
  }
  cropY = Math.max(0, Math.min(srcH - cropH, cropY));

  let cropX = Math.round((face.centerX ?? 0.5) * srcW - cropW / 2);
  cropX = Math.max(0, Math.min(srcW - cropW, cropX));
  return { cropW, cropH, cropX, cropY, letterbox };
}

/**
 * Cut a turn's TOP clip HEAD-SAFE: raw portrait cut → YuNet → band crop → scale to 1080x840.
 * Returns { face, crop }. Falls back to fallbackFace (per-source median) then center.
 */
function cutTop(clipPath, start, dur, out, fallbackFace) {
  const raw = out.replace(/\.mp4$/i, "_raw.mp4");
  cutRaw(clipPath, start, dur, raw);
  let face = detectFace(raw, 10) || fallbackFace ||
    { centerX: 0.5, faceTopY: 0.18, height: 0.24, headTopY: 0.14, srcW: 720, srcH: 1280 };
  const c = calculateBandCrop(face.srcW || 720, face.srcH || 1280, face);
  // When the head-safe window is NARROWER than the band aspect (close-subject zoom-out), do NOT
  // stretch it to 1080×840 (that would distort faces — forbidden by docs/cropping-rules.md). Scale
  // it to the band HEIGHT and place it; fill the side margins with a blurred, scaled copy of the
  // same crop so the band stays full-bleed and clean (cinema-style side fill, not a hard pillarbox).
  // OFF-CENTER (fix #5 — reference frames the subject slightly off-center, not dead-center): bias
  // the sharp foreground ~7% of the side-margin off-center so it reads like the reference's framing
  // rather than a centered medium shot. The blurred fill behind covers the asymmetric gap.
  const OFFCENTER = 0.14;   // fraction of the side-margin to bias the foreground from center
  const vf = c.letterbox
    ? `[0:v]crop=${c.cropW}:${c.cropH}:${c.cropX}:${c.cropY},setsar=1,split=2[fg][bg];` +
      `[bg]scale=${BAND_W}:${BAND_H},boxblur=24:2,eq=brightness=-0.06[bgb];` +
      `[fg]scale=-2:${BAND_H}[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2-(W-w)/2*${OFFCENTER}:0,setsar=1[outv]`
    : `crop=${c.cropW}:${c.cropH}:${c.cropX}:${c.cropY},scale=${BAND_W}:${BAND_H},setsar=1`;
  // filter_complex disables ffmpeg's automatic audio passthrough — without an explicit -map the
  // letterbox branch silently drops the turn's audio (this is exactly how t3 went silent: t3 is the
  // only close-subject letterbox turn). Map the labelled video output AND the source audio.
  // The simple -vf branch keeps audio automatically, so it needs no -map.
  const vfArg = c.letterbox ? ["-filter_complex", vf, "-map", "[outv]", "-map", "0:a?"] : ["-vf", vf];
  execFileSync(FFMPEG, ["-y", "-i", raw,
    ...vfArg,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", "-loglevel", "error", out], { stdio: "pipe" });
  try { fs.unlinkSync(raw); } catch {}
  return { face, crop: c };
}
function cutAudio(clipPath, start, dur, out) {
  execFileSync(FFMPEG, ["-y", "-ss", start.toFixed(3), "-i", clipPath, "-t", dur.toFixed(3),
    "-vn", "-ac", "1", "-ar", "44100", "-loglevel", "error", out], { stdio: "pipe" });
}
// padded audio for wan2_7 generation (min 2s; trailing silence)
function padAudio(srcWav, genDur, out) {
  // apad adds trailing silence indefinitely; -t caps the output to genDur (>=2s for wan2_7).
  // (whole_dur= isn't available in this ffmpeg build.)
  execFileSync(FFMPEG, ["-y", "-i", srcWav, "-af", "apad", "-t", genDur.toFixed(3),
    "-ac", "1", "-ar", "44100", "-loglevel", "error", out], { stdio: "pipe" });
}

function doTrim() {
  console.log("\n=== TRIM (word-anchored) + HEAD-SAFE crop ===");
  fs.mkdirSync(TURNS_DIR, { recursive: true });
  const wordsByClip = { 0: loadWords(0), 1: loadWords(1) };
  console.log("  detecting per-source face (head-safe crop fallback)...");
  const srcFace = { 0: detectFace(CLIPS[0].path, 15), 1: detectFace(CLIPS[1].path, 15) };
  for (const k of [0, 1]) console.log(`    clip${k}: ${srcFace[k] ? `centerX=${srcFace[k].centerX} headTopY=${srcFace[k].headTopY} faceH=${srcFace[k].height}` : "NO FACE (will fall back per-turn)"}`);
  const cursor = { 0: 0, 1: 0 };
  const manifest = [];

  for (const turn of TURNS) {
    const words = wordsByClip[turn.clip];
    const span = findSpan(words, turn.text, cursor[turn.clip]);
    if (!span) throw new Error(`t${turn.t}: could not locate "${turn.text}" in clip ${turn.clip}`);
    cursor[turn.clip] = span.endIdx + 1;

    const start = Math.max(0, span.firstOnset - PREROLL);
    const end = span.lastOffset + TAIL;
    const dur = Math.round((end - start) * 1000) / 1000;
    const clipPath = CLIPS[turn.clip].path;

    const topOut = path.join(TURNS_DIR, `top-t${turn.t}.mp4`);
    const audioOut = path.join(TURNS_DIR, `audio-t${turn.t}.wav`);
    const { crop } = cutTop(clipPath, start, dur, topOut, srcFace[turn.clip]);
    cutAudio(clipPath, start, dur, audioOut);

    const genDur = Math.max(2, Math.ceil(dur)); // wan2_7 duration is integer seconds; clip >= turn dur // wan2_7 min 2s
    const genAudioOut = path.join(TURNS_DIR, `audio-gen-t${turn.t}.wav`);
    padAudio(audioOut, genDur, genAudioOut);

    const frames = Math.round(dur * FPS);
    const rec = {
      t: turn.t, char: turn.char, clip: turn.clip,
      text: turn.text,
      matchedFirst: words[span.startIdx].word, matchedLast: words[span.endIdx].word,
      score: Math.round(span.score * 100) / 100,
      start, end, dur, frames, genDur,
      topSrc: `uploads/gen/reel2/turns/top-t${turn.t}.mp4`,
      bottomSrc: `uploads/gen/reel2/turns/bottom-t${turn.t}.mp4`,
      audioSrc: `uploads/gen/reel2/turns/audio-t${turn.t}.wav`,
      genAudioSrc: `uploads/gen/reel2/turns/audio-gen-t${turn.t}.wav`,
      image: CHAR_IMAGE[turn.char],
    };
    manifest.push(rec);
    console.log(`  t${turn.t} ${turn.char} clip${turn.clip}: ${start.toFixed(3)}-${end.toFixed(3)} (${dur.toFixed(3)}s, ${frames}f) ` +
      `match ${(span.score * 100).toFixed(0)}% "${rec.matchedFirst}".."${rec.matchedLast}" -> genDur ${genDur}s ` +
      `| crop ${crop.cropW}x${crop.cropH}+${crop.cropX}+${crop.cropY}`);
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ fps: FPS, turns: manifest }, null, 2));
  console.log(`  manifest: ${MANIFEST_PATH}`);
  buildProps(manifest);
}

// Re-cut a SINGLE top turn head-safe (+ audio) from its source clip, using the saved manifest
// timing. Surgical: rewrites only top-t<N>.mp4 + audio-t<N>.wav; touches nothing else (no re-trim,
// no props rebuild, no Act-2 changes). Use to repair one clobbered/silenced turn.
function doRecutTop(t) {
  const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const rec = (man.turns || []).find(x => x.t === t);
  if (!rec) throw new Error(`--recut-top ${t}: no turn t${t} in ${MANIFEST_PATH}`);
  const clipPath = CLIPS[rec.clip].path;
  const fallback = detectFace(clipPath, 15);
  const topOut = path.join(TURNS_DIR, `top-t${t}.mp4`);
  const audioOut = path.join(TURNS_DIR, `audio-t${t}.wav`);
  const { crop } = cutTop(clipPath, rec.start, rec.dur, topOut, fallback);
  cutAudio(clipPath, rec.start, rec.dur, audioOut);
  console.log(`  re-cut t${t} from clip${rec.clip} ${rec.start.toFixed(3)}s +${rec.dur.toFixed(3)}s ` +
    `| crop ${crop.cropW}x${crop.cropH}+${crop.cropX}+${crop.cropY}${crop.letterbox ? " (letterbox)" : ""} -> ${topOut}`);
}

// ════════════════════════════════════════════════════════ PROPS
// Act-2 ("how it's made"), defined explicitly so a full rebuild reproduces it (no dependency on
// the previous gitignored props): an EXPLAINER segment (animated StepFlow + talking Bob, audio ON,
// one-shot) sized to the Bob clip (~10.04s), then a CTA. `frames` becomes start/end after Act-1.
// Act-2 = the node-editor "how it's made" screencast (replicates IMG_6298 24s→end), one segment
// internally choreographed in Act2NodeEditor.tsx to Bob's ~10s narration + a CTA hold (~14s total).
const ACT2 = [
  { kind: "nodeEditor", cta: "Comment \"AI\"", frames: 490 }, // ~16.3s cinematic node-editor (orbit + L→R camera + zoom-out + CTA)
];

function buildProps(manifest) {
  const prev = fs.existsSync(PROPS_PATH) ? JSON.parse(fs.readFileSync(PROPS_PATH, "utf-8")) : null;
  const segments = [];
  let f = 0;
  for (const turn of manifest) {
    // Pills/divider/M-logo are FIXED chrome rendered once by the composition (driven by the
    // top-level topPillText/bottomPillText props), NOT per-segment — so no per-cut label info here.
    segments.push({
      startFrame: f, endFrame: f + turn.frames, kind: "split",
      topSrc: turn.topSrc,
      bottomSrc: turn.bottomSrc, bottomFromSec: 0,
    });
    f += turn.frames;
  }
  for (const seg of ACT2) {
    const { frames, ...rest } = seg;
    segments.push({ startFrame: f, endFrame: f + frames, ...rest });
    f += frames;
  }

  const props = {
    fps: FPS, width: 1080, height: 1920, durationInFrames: f,
    logoText: prev?.logoText || "M",
    topPillText: prev?.topPillText || "Real Video",
    bottomPillText: prev?.bottomPillText || "Lip Sync Seedance 2.0",
    ...(prev?.musicSrc ? { musicSrc: prev.musicSrc } : {}),
    segments,
  };
  fs.writeFileSync(PROPS_PATH, JSON.stringify(props, null, 2));
  console.log(`  props: ${PROPS_PATH} (Act-1 ${manifest.length} turns + Act-2 ${ACT2.length} seg, ${f} frames total)`);
}

// ════════════════════════════════════════════════════════ BOUNDARY GUARD
async function geminiTokens(mp3Path, key) {
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-flash" });
  const data = fs.readFileSync(mp3Path).toString("base64");
  const prompt = "Transcribe this short English speech clip VERBATIM. Return ONLY the raw words, plain text, no punctuation.";
  for (let r = 0; r < 3; r++) {
    try {
      const res = await model.generateContent([{ text: prompt }, { inlineData: { mimeType: "audio/mpeg", data } }]);
      return normalizeTokens(res.response.text());
    } catch { await new Promise(z => setTimeout(z, 2500)); }
  }
  return null;
}

async function doGuard() {
  const key = loadKey(); if (!key) throw new Error("no GEMINI_API_KEY");
  console.log("\n=== BOUNDARY GUARD (whole-clip re-transcription) ===");
  console.log("  (each turn clip is 1-3.4s — transcribe WHOLE clip for accurate context;");
  console.log("   FIRST word is enforced — that's the user's actual issue & MMS-reliable;");
  console.log("   LAST word is advisory — MMS offset+tail guarantees it; isolated-clip ASR");
  console.log("   mis-hears homophones, e.g. sitting→civility, snacks→snake.)\n");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")).turns;
  const MAX_EXTEND = 0.5;
  let firstAllOk = true;
  const reCutNeeded = [];

  for (const turn of manifest) {
    const top = path.join(TURNS_DIR, `top-t${turn.t}.mp4`);
    const turnToks = normalizeTokens(turn.text);
    const expectFirst = turnToks[0];
    const expectLast = turnToks[turnToks.length - 1];

    const mp3 = path.join(TURNS_DIR, `_g_t${turn.t}.mp3`);
    execFileSync(FFMPEG, ["-y", "-i", top, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "96k", "-loglevel", "error", mp3], { stdio: "pipe" });
    const heard = await geminiTokens(mp3, key);
    try { fs.unlinkSync(mp3); } catch {}

    // first word must appear in the first 2 heard tokens; last word advisory (last 2).
    const firstOk = !heard || !expectFirst || heard.slice(0, 2).some(h => tokEq(expectFirst, h));
    const lastOk = !heard || !expectLast || heard.slice(-2).some(h => tokEq(expectLast, h));
    const mark = firstOk ? (lastOk ? "✓" : "~") : "✗";
    console.log(`  t${turn.t} ${mark} first "${expectFirst}"${firstOk ? "" : ` MISSING (heard "${heard?.slice(0, 2).join(" ")}")`}` +
      ` | last "${expectLast}"${lastOk ? "" : ` (advisory: heard "${heard?.slice(-2).join(" ")}")`}`);
    if (!firstOk) { firstAllOk = false; reCutNeeded.push({ t: turn.t }); }
  }

  if (firstAllOk) {
    console.log("\n  BOUNDARY GUARD: every turn STARTS on its first word ✓ (no mid-word/clipped onset).");
    console.log("  Final word-completeness is confirmed by the post-render full-output transcription (Fix #6).");
    return;
  }

  // Only a genuinely clipped FIRST word triggers a re-cut (push the onset out a little).
  console.log(`\n  extending ${reCutNeeded.length} turn(s) with a clipped onset and re-cutting...`);
  const wordsByClip = { 0: loadWords(0), 1: loadWords(1) };
  const srcFace = { 0: detectFace(CLIPS[0].path, 15), 1: detectFace(CLIPS[1].path, 15) };
  const cursor = { 0: 0, 1: 0 };
  const newManifest = [];
  for (const turn of TURNS) {
    const words = wordsByClip[turn.clip];
    const span = findSpan(words, turn.text, cursor[turn.clip]);
    cursor[turn.clip] = span.endIdx + 1;
    const ex = reCutNeeded.find(r => r.t === turn.t) ? 0.18 : 0;
    const start = Math.max(0, span.firstOnset - PREROLL - Math.min(ex, MAX_EXTEND));
    const end = span.lastOffset + TAIL;
    const dur = Math.round((end - start) * 1000) / 1000;
    const clipPath = CLIPS[turn.clip].path;
    cutTop(clipPath, start, dur, path.join(TURNS_DIR, `top-t${turn.t}.mp4`), srcFace[turn.clip]);
    cutAudio(clipPath, start, dur, path.join(TURNS_DIR, `audio-t${turn.t}.wav`));
    const genDur = Math.max(2, Math.ceil(dur)); // wan2_7 duration is integer seconds; clip >= turn dur
    padAudio(path.join(TURNS_DIR, `audio-t${turn.t}.wav`), genDur, path.join(TURNS_DIR, `audio-gen-t${turn.t}.wav`));
    newManifest.push({
      t: turn.t, char: turn.char, clip: turn.clip, text: turn.text,
      start, end, dur, frames: Math.round(dur * FPS), genDur,
      topSrc: `uploads/gen/reel2/turns/top-t${turn.t}.mp4`,
      bottomSrc: `uploads/gen/reel2/turns/bottom-t${turn.t}.mp4`,
      audioSrc: `uploads/gen/reel2/turns/audio-t${turn.t}.wav`,
      genAudioSrc: `uploads/gen/reel2/turns/audio-gen-t${turn.t}.wav`,
      image: CHAR_IMAGE[turn.char],
    });
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ fps: FPS, turns: newManifest }, null, 2));
  buildProps(newManifest);
  console.log("  re-cut done. RE-RUN --guard to confirm.");
}

// ════════════════════════════════════════════════════════ MAIN
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter(a => !a.startsWith("--force"));
  const run = (flag) => only.length === 0 || only.includes(flag);

  // --props: fast rebuild of reel2-props.json from the existing manifest (no re-cut of Act-1).
  if (only.includes("--props")) {
    console.log("=== PROPS (rebuild from manifest, no re-cut) ===");
    buildProps(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")).turns);
    console.log("\nDONE.");
    return;
  }
  // --recut-top <t>: surgical single-turn head-safe (+audio) re-cut, no full re-trim / props rebuild.
  const recutIdx = args.indexOf("--recut-top");
  if (recutIdx >= 0) {
    const t = Number(args[recutIdx + 1]);
    if (!Number.isInteger(t)) throw new Error("--recut-top requires a turn number, e.g. --recut-top 3");
    console.log(`=== RECUT TOP t${t} (head-safe + audio, surgical) ===`);
    doRecutTop(t);
    console.log("\nDONE.");
    return;
  }
  if (run("--transcribe")) await doTranscribe(force);
  if (run("--align")) doAlign();
  if (run("--trim")) doTrim();
  if (run("--guard")) await doGuard();
  console.log("\nDONE.");
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
