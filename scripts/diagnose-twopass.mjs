/**
 * Validate the two-pass CV detection strategy from cv-correction.ts
 * against the known-correct reference positions for ref.MOV.
 *
 * Pass A: xMax=84% width (907px), yMin=10% height (192px)
 * Pass B: xMax=75% width (810px) for segments where Pass A cx > 810
 *
 * Expected results (ref.MOV):
 *   seg_2: cx=745, cy=565, r≈205
 *   seg_3: cx=793, cy=518, r≈218
 *   seg_4: cx=755, cy=485, r≈215
 *   seg_5: cx=685, cy=275, r≈215
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const { measureReferenceCircles } = await import("@/lib/analysis/reference-measurer");
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "references", "ref.MOV");
const CANVAS = { width: 1080, height: 1920 };

const SEGMENTS = [
  { id: "seg_2", start: 3.0,  end: 9.2,  shape: "circle" },
  { id: "seg_3", start: 9.2,  end: 12.8, shape: "circle" },
  { id: "seg_4", start: 12.8, end: 17.9, shape: "circle" },
  { id: "seg_5", start: 17.9, end: 24.1, shape: "circle" },
];

const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

// LLM-estimated radii from 278b7f blueprint (placeholder, close to actual)
const medianLlmR = 215;

// ── Two-pass parameters (matches cv-correction.ts) ──
// LLM-seeded xMin from placeholder bbox {x:545, y:215, w:430, h:430}: cx=760, marginX=215 → xMin=545
const xMinLlm    = 545;  // Math.max(0, 760 - Math.max(215, 1080*0.15)) = 545
const xMaxWide   = Math.round(CANVAS.width * 0.84);  // 907
const xMaxNarrow = Math.round(CANVAS.width * 0.75);  // 810
const xMinLeft   = xMinLlm;  // same as LLM-seeded xMin
const yMin       = Math.round(CANVAS.height * 0.10); // 192
const yMax       = Math.round(CANVAS.height * 0.50); // 960

const rMin = Math.max(60, Math.round(medianLlmR * 0.93));  // 200 (±7%)
const rMax = Math.round(medianLlmR * 1.07);                // 230 (±7%)

const tmpDir = path.join(ROOT, "public", "exports", "diag-twopass");
fs.mkdirSync(tmpDir, { recursive: true });

console.log(`\n=== TWO-PASS CV DETECTION (mimicking cv-correction.ts) ===`);
console.log(`  Pass A: x=[${xMinLlm},${xMaxWide}] y=[${yMin},${yMax}] r=[${rMin},${rMax}]`);
console.log(`  Pass B: x=[${xMinLlm},${xMaxNarrow}] (triggered if Pass A cx > ${xMaxNarrow})`);
console.log(`  Left-edge filter: reject Pass B cx < ${xMinLeft}`);

// ── Pass A ──
console.log(`\n--- Pass A ---`);
const passA = await measureReferenceCircles({
  ffmpegPath: FFMPEG, refVideoPath: REF, canvas: CANVAS,
  segments: SEGMENTS,
  tmpDir,
  centerRegion: { xMin: xMinLlm, xMax: xMaxWide, yMin, yMax },
  radiusRange: { min: rMin, max: rMax },
  framesPerSegment: 30,
  useTemporalClustering: true,
});

for (const seg of SEGMENTS) {
  const m = passA.get(seg.id);
  if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
  const ref = REF_CORRECT[seg.id];
  const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
  const gate = dx<=30&&dy<=30?"PASS30":dx<=50&&dy<=50?"PASS50":"FAIL";
  const needsB = !m.confident || m.cx > xMaxNarrow;
  console.log(`  ${seg.id}: (${m.cx},${m.cy},r=${m.radius}) n=${m.samples} conf=${m.confident} dx=${dx} dy=${dy} ${gate}${needsB?" → needsPassB":""}`);
}

// ── Identify segments needing Pass B ──
const needsPassB = SEGMENTS.filter((s) => {
  if (s.shape !== "circle") return false;
  const m = passA.get(s.id);
  return !m || !m.confident || m.cx > xMaxNarrow;
});

console.log(`\n  Segments for Pass B: ${needsPassB.length > 0 ? needsPassB.map(s=>s.id).join(", ") : "(none)"}`);

// ── Pass B ──
let passB = null;
if (needsPassB.length > 0) {
  console.log(`\n--- Pass B ---`);
  const passBRaw = await measureReferenceCircles({
    ffmpegPath: FFMPEG, refVideoPath: REF, canvas: CANVAS,
    segments: needsPassB,
    tmpDir,
    centerRegion: { xMin: xMinLlm, xMax: xMaxNarrow, yMin, yMax },
    radiusRange: { min: rMin, max: rMax },
    framesPerSegment: 30,
    useTemporalClustering: true,
  });
  passB = new Map();
  for (const [id, m] of Array.from(passBRaw.entries())) {
    if (m.cx >= xMinLeft) {
      passB.set(id, m);
      const ref = REF_CORRECT[id];
      const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
      const gate = dx<=30&&dy<=30?"PASS30":dx<=50&&dy<=50?"PASS50":"FAIL";
      console.log(`  ${id}: (${m.cx},${m.cy},r=${m.radius}) n=${m.samples} conf=${m.confident} dx=${dx} dy=${dy} ${gate}`);
    } else {
      console.log(`  ${id}: cx=${m.cx} REJECTED (< ${xMinLeft} left-edge filter)`);
    }
  }
}

// ── Merge ──
console.log(`\n--- FINAL (merged) ---`);
const yMinResult = Math.round(CANVAS.height * 0.13); // 249px
const measured = new Map(passA);
if (passB) {
  for (const [id, mb] of Array.from(passB.entries())) {
    const ma = passA.get(id);
    if (!ma || !ma.confident || (mb.confident && mb.samples > ma.samples)) {
      measured.set(id, mb);
    }
  }
}

let pass30 = 0, pass50 = 0;
for (const seg of SEGMENTS) {
  const m = measured.get(seg.id);
  if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
  const ref = REF_CORRECT[seg.id];
  const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
  const gate = dx<=30&&dy<=30?"PASS30":dx<=50&&dy<=50?"PASS50":"FAIL";
  const src = passB?.has(seg.id) && (() => {
    const mb = passB.get(seg.id);
    const ma = passA.get(seg.id);
    return !ma || !ma.confident || (mb.confident && mb.samples > ma.samples);
  })() ? "B" : "A";
  // Apply the same gates as cv-correction.ts
  const confGate = m.confident;
  const cyGate = m.cy >= yMinResult;
  const wouldApply = confGate && cyGate;
  if (gate==="PASS30"){pass30++;pass50++;}else if(gate==="PASS50")pass50++;
  console.log(`  ${seg.id}[pass${src}]: (${m.cx},${m.cy},r=${m.radius}) n=${m.samples} conf=${m.confident} cy≥${yMinResult}=${cyGate} WOULD_APPLY=${wouldApply} ref=(${ref.cx},${ref.cy}) dx=${dx} dy=${dy} ${gate}`);
}
console.log(`\n  RESULT: ${pass30}/4 PASS30  ${pass50}/4 PASS50`);
console.log(pass30 >= 3 && pass50 === 4 ? "\n  ✓ Two-pass strategy validated!" : "\n  ✗ NOT passing targets (3+ PASS30, 4/4 PASS50)");

process.exit(0);
