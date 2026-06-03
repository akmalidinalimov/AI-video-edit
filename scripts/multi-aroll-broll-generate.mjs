/**
 * multi-aroll-broll-generate.mjs — B-ROLL GENERATION ORCHESTRATOR.
 *
 * Splits the generate→verify→assemble loop into the DETERMINISTIC parts (this script)
 * and the MCP parts (the AGENT calls generate_video). See docs/broll-generation.md.
 *
 *   1) node scripts/multi-aroll-broll-generate.mjs --plan [--segs 1,4]
 *        → director plans single-shot BEATS per segment → broll-gen-manifest.json
 *          (prints each beat's model + prompt for the agent to generate via MCP).
 *   2) AGENT: for each manifest beat, call generate_video(model, prompt, 9:16 pro,
 *        sound off, decline preset), poll show_generations, and write a results map
 *        { "<beatId>": "<resultUrl>", ... } to broll-gen-results.json.
 *   3) node scripts/multi-aroll-broll-generate.mjs --ingest
 *        → download each beat, run the CLEANLINESS gate (reject gibberish/text), and
 *          write ordered beats[] into broll-plan.json for segments whose beats ALL pass.
 *          Beats that fail are listed for regen (reframed real-world prompt).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { planDirective } from "./lib/broll/registry.mjs";
import { checkCleanliness } from "./lib/broll-cleanliness.mjs";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const GEN_DIR = path.join(ROOT, "public", "uploads", "gen");
const REF_GT = path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json");
const MANIFEST = path.join(STAGE2, "broll-gen-manifest.json");
const RESULTS = path.join(STAGE2, "broll-gen-results.json");

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}
const layoutOf = (() => { try { return JSON.parse(fs.readFileSync(REF_GT, "utf-8")).map(s => s.shape); } catch { return []; } })();

async function doPlan(key) {
  const tl = JSON.parse(fs.readFileSync(path.join(STAGE2, "clean-timeline.json"), "utf-8"));
  const only = arg("--segs", null); // e.g. "1,4"
  const wanted = only ? new Set(only.split(",").map(n => +n.trim())) : null;
  fs.mkdirSync(GEN_DIR, { recursive: true });

  const segments = [];
  for (let i = 0; i < tl.segments.length; i++) {
    const isCircle = (layoutOf[i] || "circle") !== "rectangle"; // hook = no full b-roll
    if (!isCircle) continue;
    if (wanted && !wanted.has(i)) continue;
    const s = tl.segments[i];
    const seg = { seg: i, role: s.role, text: s.text, semanticTags: s.semanticTags, neededDur: +(s.timelineEnd - s.timelineStart).toFixed(2), layout: "circle" };
    console.log(`Planning beats for seg${i} (${seg.role}, ${seg.neededDur}s)...`);
    const dir = await planDirective(seg, { apiKey: key });
    const beats = dir.beats.map((b, j) => ({ id: `seg${i}_b${j}`, ...b, outFile: `public/uploads/gen/seg${i}_b${j}.mp4` }));
    segments.push({
      seg: i, role: seg.role, neededDur: seg.neededDur,
      contentType: dir.contentType, productMode: dir.productMode, strategy: dir.strategy,
      entities: dir.entities, reframeNote: dir.reframeNote, beats,
    });
    console.log(`  contentType=${dir.contentType}${dir.productMode && dir.productMode !== "none" ? "/" + dir.productMode : ""} · strategy=${dir.strategy} · ${beats.length} beat(s)${dir.reframeNote ? " · reframe: " + dir.reframeNote : ""}`);
    for (const b of beats) console.log(`    ${b.id} [${b.kind}${b.model ? ":" + b.model : ""}] ${b.durationSec}s "${b.concept}"`);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ segments }, null, 2));
  console.log(`\nWrote ${MANIFEST}`);
  console.log(`\n── AGENT: generate each GENERATED beat via MCP generate_video, then write ${path.basename(RESULTS)} as { "<beatId>": "<resultUrl>" } ──`);
  for (const sg of segments) for (const b of sg.beats) {
    if (b.kind !== "generated") { console.log(`\n# ${b.id}  kind=${b.kind} (non-generated — handled by its renderer consumer, skip MCP)`); continue; }
    console.log(`\n# ${b.id}  model=${b.model}  duration=${Math.round(b.durationSec)}  aspect=9:16 ${b.model === "seedance_2_0" ? "resolution=1080p" : "mode=pro sound=off"}`);
    console.log(b.prompt);
  }
}

async function doIngest(key) {
  if (!fs.existsSync(MANIFEST)) { console.error("No manifest — run --plan first."); process.exit(1); }
  if (!fs.existsSync(RESULTS)) { console.error(`No ${RESULTS} — agent must write the {beatId:url} map.`); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
  const results = JSON.parse(fs.readFileSync(RESULTS, "utf-8"));
  const plan = JSON.parse(fs.readFileSync(path.join(STAGE2, "broll-plan.json"), "utf-8"));
  fs.mkdirSync(GEN_DIR, { recursive: true });

  const regen = [];
  for (const sg of manifest.segments) {
    const beatRecords = [];
    let allPass = true;
    for (const b of sg.beats) {
      if (b.kind && b.kind !== "generated") {
        // Non-generated kinds (image_sequence/screen_recording/stock) are wired by their
        // own renderer consumer (future) — pass them straight through to the plan.
        beatRecords.push({ source: b.asset || null, order: b.order, durationShare: b.durationSec, kind: b.kind, concept: b.concept });
        console.log(`  ${b.id}: kind=${b.kind} (passthrough)`);
        continue;
      }
      const url = results[b.id];
      if (!url) { console.log(`  ${b.id}: no URL in results — skip`); allPass = false; regen.push({ id: b.id, reason: "missing url", concept: b.concept }); continue; }
      // download
      const out = path.resolve(ROOT, b.outFile);
      try {
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        fs.writeFileSync(out, buf);
      } catch (e) { console.log(`  ${b.id}: download failed (${e.message})`); allPass = false; regen.push({ id: b.id, reason: "download", concept: b.concept }); continue; }
      // cleanliness gate
      const cl = await checkCleanliness(b.outFile, { apiKey: key, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, root: ROOT });
      const flag = cl.pass ? "CLEAN" : (cl.hasText ? "TEXT!" : "ARTIFACT");
      console.log(`  ${b.id} [${b.model}] clean=${cl.clean} ${flag} "${cl.note}"`);
      if (!cl.pass) { allPass = false; regen.push({ id: b.id, reason: cl.hasText ? "on-screen text" : "artifacts/low-clean", clean: cl.clean, concept: b.concept }); }
      beatRecords.push({ source: b.outFile, order: b.order, durationShare: b.durationSec, model: b.model, concept: b.concept, clean: cl.clean, hasText: cl.hasText });
    }
    const seg = plan.segments.find(s => s.seg === sg.seg);
    if (!seg) { console.log(`  seg${sg.seg}: not in broll-plan — skip`); continue; }
    if (allPass && beatRecords.length) {
      delete seg.source; seg.brollStartSec = 0;
      seg.beats = beatRecords.sort((a, b) => a.order - b.order);
      seg.screen = `GENERATED beats: ${seg.beats.map(b => b.concept).join(" → ")}`;
      seg.reason = `B-roll generation system: ${sg.strategy}, ${beatRecords.length} clean single-shot beat(s)${sg.reframeNote ? " (reframed: " + sg.reframeNote + ")" : ""}.`;
      console.log(`  seg${sg.seg}: ✅ ${beatRecords.length} beat(s) accepted → broll-plan.json`);
    } else {
      console.log(`  seg${sg.seg}: ⚠ NOT updated — ${beatRecords.length - (beatRecords.filter(b => b.clean >= 70 && !b.hasText).length)} beat(s) failed cleanliness; regenerate them.`);
    }
  }
  fs.writeFileSync(path.join(STAGE2, "broll-plan.json"), JSON.stringify(plan, null, 2));
  if (regen.length) {
    console.log(`\n── REGEN NEEDED (reframe to cleaner real-world, less screen/text) ──`);
    for (const r of regen) console.log(`  ${r.id} (${r.reason}${r.clean != null ? ", clean=" + r.clean : ""}): "${r.concept}"`);
    process.exit(2);
  }
  console.log(`\n✅ All beats clean and written to broll-plan.json.`);
}

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  if (process.argv.includes("--plan")) await doPlan(key);
  else if (process.argv.includes("--ingest")) await doIngest(key);
  else { console.error("Usage: --plan [--segs 1,4]  |  --ingest"); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
