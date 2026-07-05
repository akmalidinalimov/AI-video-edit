/**
 * rerender-from-plan.ts — re-run ONLY the FFmpeg render from a saved plan +
 * template, through the current renderer code. Lets us verify renderer changes
 * (face-safe crop, full-bleed B-roll) fast, without re-running Gemini analysis.
 *
 * Usage:
 *   npx tsx scripts/rerender-from-plan.ts [plan.json] [template.json]
 * Defaults to public/exports/sp-temp/{dynamic-plan,dynamic-template}.json
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { buildRenderArgsWithScript, buildBrollMontageArgs, toMontageCompositePlan } from "../src/lib/pipeline/plan-renderer";
import { detectArollGroup } from "../src/lib/pipeline/yunet-face";

const root = process.cwd();
const FFMPEG = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flags = argv.filter((a) => a.startsWith("--"));
const planPath = positional[0] || path.join(root, "public/exports/sp-temp/dynamic-plan.json");
const tmplPath = positional[1] || path.join(root, "public/exports/sp-temp/dynamic-template.json");
const paceFlag = flags.find((f) => f.startsWith("--pace"));
const paceSec = paceFlag ? parseFloat(paceFlag.split("=")[1]) || 1.5 : 0;

const planRaw = JSON.parse(fs.readFileSync(planPath, "utf8"));
const template = JSON.parse(fs.readFileSync(tmplPath, "utf8"));

/**
 * Post-hoc pacing test: subdivide each layout range into ~shotSec sub-shots
 * (same layout/PIP — only the B-roll behind cuts) and ROTATE the B-roll source
 * per sub-shot for visible variety. This mirrors the plan-builder's real Step 4b
 * so we can SEE the cadence without re-running Gemini. (The real plan-builder
 * picks RELEVANT clips via matchBrollScenes; here we just rotate for the test.)
 */
function paceify(p: any, shotSec: number): any {
  const fps: number = p.fps;
  const clips: Array<{ duration?: number }> = p.sources.brollClips ?? [];
  const nSrc = clips.length || 1;
  const out: any[] = [];
  let g = 0;
  for (const r of p.layoutRanges) {
    const start = r.timeRange.start;
    const end = r.timeRange.end;
    const dur = end - start;
    // Subdivide to the reference cadence on EVERY range (B-roll swaps mid-sentence, like the
    // reference): ceil so a ~1.5s range at a ~1s cadence yields 2 shots, not 1.
    const nShots = dur > shotSec * 1.35 ? Math.max(1, Math.ceil(dur / shotSec)) : 1;
    const shotDur = dur / nShots;
    for (let k = 0; k < nShots; k++) {
      const s = +(start + k * shotDur).toFixed(4);
      const e = k === nShots - 1 ? end : +(start + (k + 1) * shotDur).toFixed(4);
      const src = nShots > 1 ? g % nSrc : r.brollSourceIndex ?? 0;
      const cd = clips[src]?.duration ?? 30;
      const off = Math.min(2 + (g % 3), Math.max(0, cd - 2));
      out.push({
        ...r,
        id: `${r.id}_${k + 1}`,
        timeRange: { start: s, end: e },
        startFrame: Math.round(s * fps),
        endFrame: Math.round(e * fps),
        enableExpr: `between(t,${s.toFixed(4)},${e.toFixed(4)})`,
        brollSourceIndex: src,
        brollOffset: off,
        brollSpeed: 1.0,
        brollKeyframes: undefined,
        brollCropRegion: undefined,
      });
      g++;
    }
  }
  console.log(`[pace] subdivided ${p.layoutRanges.length} → ${out.length} B-roll shots (~${shotSec}s)`);
  return { ...p, layoutRanges: out };
}

const plan = paceSec > 0 ? paceify(planRaw, paceSec) : planRaw;

const arollPath: string = plan.sources.aroll;
const arollClips: string[] = (plan.sources.arollClips ?? [{ path: arollPath }]).map(
  (c: { path: string }) => c.path
);

// Source dims via ffmpeg -i (ffmpeg exits 1 with no output → read stderr).
function videoDims(p: string): { width: number; height: number } {
  let info = "";
  try { execFileSync(FFMPEG, ["-i", p], { stdio: "pipe" }); }
  catch (e) { info = String((e as { stderr?: Buffer }).stderr ?? ""); }
  const m = info.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!m) throw new Error(`could not read dims for ${p}`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

const arollSourceDimensions = videoDims(arollPath);
console.log(`A-roll source dims: ${arollSourceDimensions.width}×${arollSourceDimensions.height}`);

// YuNet GROUP box (all faces) → square crop that frames everyone.
const groups = arollClips.map((p) => detectArollGroup(p)).filter((g): g is NonNullable<typeof g> => !!g);
let arollFace: { centerX: number; centerY: number; height: number; width?: number } | undefined;
if (groups.length) {
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  arollFace = {
    centerX: avg(groups.map((g) => g.centerX)),
    centerY: avg(groups.map((g) => g.centerY)),
    height: avg(groups.map((g) => g.faceHeight)),
    width: avg(groups.map((g) => g.width)),
  };
  console.log(`A-roll group (${groups[0].nFaces} faces): center=(${arollFace.centerX.toFixed(3)},${arollFace.centerY.toFixed(3)}) groupW=${(arollFace.width ?? 0).toFixed(3)}`);
} else {
  console.warn("group detection found no faces — center-crop fallback");
}

const ts = Date.now();
const outName = `rerender-${ts}.mp4`;
const outputPath = path.join(root, "public/exports", outName);
const filterScriptPath = path.join(root, "public/exports/sp-temp", `filter-rerender-${ts}.txt`);

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd: root });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      const t = d.toString().match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (t) process.stdout.write(`\r  ${label} ${t[0]}   `);
    });
    p.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) resolve();
      else {
        console.error(err.split("\n").filter((l) => /error|Invalid|memory/i.test(l)).slice(0, 8).join("\n"));
        reject(new Error(`${label} exit ${code}`));
      }
    });
  });
}

// Two-pass: when the plan cuts B-roll per range, render the montage first
// (memory-light cut-list), then composite A-roll/text over it as a single
// full-canvas background. (Wrapped in an async IIFE — tsx targets CJS, so no
// top-level await.)
void (async () => {
  const hasOffsets = plan.layoutRanges.some((r: { brollOffset?: number }) => r.brollOffset !== undefined);
  let compositePlan = plan;
  if (hasOffsets) {
    const montagePath = path.join(root, "public/exports/sp-temp", `montage-${ts}.mp4`);
    console.log(`Pass 1: B-roll montage (${plan.layoutRanges.length} shots)...`);
    await runFfmpeg(buildBrollMontageArgs(plan, template, montagePath), "montage");
    compositePlan = toMontageCompositePlan(plan, montagePath);
  }

  const renderOutput = buildRenderArgsWithScript(
    { plan: compositePlan, template, arollSourceDimensions, arollFace, ffmpegPath: FFMPEG, outputPath },
    filterScriptPath
  );
  fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);
  console.log("Pass 2: composite...");
  await runFfmpeg(renderOutput.ffmpegArgs, "render");
  console.log(`✅ DONE: ${outputPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
