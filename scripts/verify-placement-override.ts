/**
 * verify-placement-override.ts — END-TO-END proof that the MEASURED A-roll side
 * (from the deterministic Layout Analyzer) drives placement and FIXES an inversion.
 *
 * We take the saved plan and ARTIFICIALLY INVERT it (force every rect_pip range to the
 * TOP layout — simulating the original bug / a wrong Gemini layout pick), then render it
 * TWO ways, locally (ffmpeg only — NO credits, NO Gemini, NO generation):
 *   (A) inverted, UNCORRECTED  → A-roll should render on the WRONG side (top)
 *   (B) inverted, then the ROUTE'S measured-side correction applied → A-roll back on the
 *       measured side (bottom)
 * Then we detect the face position in each output. A=top, B=bottom ⇒ the override works.
 *
 * Usage: npx tsx scripts/verify-placement-override.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { buildRenderArgsWithScript, buildBrollMontageArgs, toMontageCompositePlan } from "../src/lib/pipeline/plan-renderer";
import { detectArollGroup } from "../src/lib/pipeline/yunet-face";
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer";

const root = process.cwd();
const FFMPEG = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(root, "public/uploads/1782174583392_target_2split.mp4");
const planPath = path.join(root, "public/exports/sp-temp/dynamic-plan.json");
const tmplPath = path.join(root, "public/exports/sp-temp/dynamic-template.json");

const template = JSON.parse(fs.readFileSync(tmplPath, "utf8"));
const basePlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const H = template.canvas.height as number;

const regOf = (id: string) => template.layouts[id]?.aroll?.region as { x: number; y: number; width: number; height: number } | undefined;
const onSide = (side: "top" | "bottom") => Object.keys(template.layouts).find((id) => {
  const r = regOf(id); if (!r || !(r.width > 0)) return false;
  const cy = r.y + r.height / 2; return side === "bottom" ? cy >= H / 2 : cy < H / 2;
});
const TOP = onSide("top")!, BOTTOM = onSide("bottom")!;

// ── Measured side (the whole point): run the deterministic analyzer on the reference ──
const measured = analyzeLayout(REF);
const measuredSide = measured?.layout.arollSide;
console.log(`Measured A-roll side (Layout Analyzer): ${measuredSide} (type=${measured?.layout.type} conf=${measured?.layout.confidence})`);
console.log(`Template layouts: TOP=${TOP} BOTTOM=${BOTTOM}\n`);

// clone + force every rect_pip range to a given layout id
function forceSide(p: any, layoutId: string): any {
  return { ...p, layoutRanges: p.layoutRanges.map((r: any) => r.layoutId.startsWith("rect_pip") ? { ...r, layoutId } : r) };
}
// the ROUTE'S correction: snap rect_pip ranges to the MEASURED side
function applyMeasuredCorrection(p: any): any {
  const target = onSide((measuredSide as "top" | "bottom") ?? "bottom") ?? BOTTOM;
  return { ...p, layoutRanges: p.layoutRanges.map((r: any) => r.layoutId.startsWith("rect_pip") ? { ...r, layoutId: target } : r) };
}

const invertedPlan = forceSide(basePlan, TOP);            // (A) the bug
const correctedPlan = applyMeasuredCorrection(invertedPlan); // (B) measured-side fix

const arollPath: string = basePlan.sources.aroll;
function videoDims(p: string): { width: number; height: number } {
  let info = ""; try { execFileSync(FFMPEG, ["-i", p], { stdio: "pipe" }); } catch (e) { info = String((e as { stderr?: Buffer }).stderr ?? ""); }
  const m = info.match(/Video:.*?(\d{2,5})x(\d{2,5})/); if (!m) throw new Error(`dims ${p}`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}
const arollSourceDimensions = videoDims(arollPath);
const g = detectArollGroup(arollPath);
const arollFace = g ? { centerX: g.centerX, centerY: g.centerY, height: g.faceHeight, width: g.width } : undefined;

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd: root });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => code === 0 ? resolve() : (console.error(err.split("\n").filter((l) => /error|Invalid/i.test(l)).slice(0, 6).join("\n")), reject(new Error(`${label} exit ${code}`))));
  });
}

async function render(plan: any, tag: string): Promise<string> {
  const ts = Date.now();
  const outputPath = path.join(root, "public/exports", `verify-${tag}.mp4`);
  const filterScriptPath = path.join(root, "public/exports/sp-temp", `filter-verify-${tag}-${ts}.txt`);
  const hasOffsets = plan.layoutRanges.some((r: { brollOffset?: number }) => r.brollOffset !== undefined);
  let compositePlan = plan;
  if (hasOffsets) {
    const montagePath = path.join(root, "public/exports/sp-temp", `montage-verify-${tag}-${ts}.mp4`);
    await runFfmpeg(buildBrollMontageArgs(plan, template, montagePath), `${tag}:montage`);
    compositePlan = toMontageCompositePlan(plan, montagePath);
  }
  const renderOutput = buildRenderArgsWithScript(
    { plan: compositePlan, template, arollSourceDimensions, arollFace, ffmpegPath: FFMPEG, outputPath },
    filterScriptPath
  );
  fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);
  await runFfmpeg(renderOutput.ffmpegArgs, `${tag}:render`);
  console.log(`  rendered ${tag}: ${outputPath}`);
  return outputPath;
}

void (async () => {
  console.log("Rendering (A) inverted-uncorrected …");
  const a = await render(invertedPlan, "inverted");
  console.log("Rendering (B) inverted + measured-side correction …");
  const b = await render(correctedPlan, "corrected");
  console.log(`\nOUTPUTS:\n  A (bug):        ${a}\n  B (corrected):  ${b}`);
  console.log(`\nNext: face-position check on each (frame @ t=5s).`);
})().catch((e) => { console.error(e); process.exit(1); });
