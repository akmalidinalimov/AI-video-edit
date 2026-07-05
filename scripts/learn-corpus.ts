/**
 * learn-corpus.ts — batch learning CLI (scene-KB spec §3.3).
 *
 * Usage:
 *   node_modules/.bin/esbuild scripts/learn-corpus.ts --bundle --platform=node --format=cjs \
 *     --alias:@=./src --outfile=.tmp/learn-corpus.cjs
 *   node .tmp/learn-corpus.cjs <folder-of-reels> [--scores <scores.json>]
 *
 * Per reel: decode (CACHED layout_regions; free CV analyzeLayout; NO fresh Gemini —
 * reels without a cached VLM region layout are decoded CV-only) → segment → match →
 * report table → learn what passes gates (requires a windowed score from --scores:
 * { "<basename>": { "<t0>-<t1>": <score> } } — corpus reels without a verified render
 * score are REPORT-ONLY). Novel families → .knowledge/scene-kb/review-queue.json.
 * Idempotent: re-running learns 0 new (dedup by referenceHash+window).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer";
import { getCached } from "../src/lib/analysis/analysisCache";
import { decodeReference } from "../src/lib/analysis/reference-decode";
import { classesAgree } from "../src/lib/analysis/reference-decode";
import type { RegionLayout } from "../src/lib/analysis/layout-regions";
import { FileSceneKB } from "../src/lib/knowledge/scene-kb";
import { runLearnCorpus, type CorpusDecodeResult } from "../src/lib/knowledge/learn-corpus";

for (const line of (fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}

/** Same recipe as analysisCache.computeFileHash (first 1MB + size + mtime), local copy. */
function hashOf(filePath: string): string {
  const stat = fs.statSync(filePath);
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const n = Math.min(1024 * 1024, stat.size);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  h.update(buf); h.update(stat.size.toString()); h.update(stat.mtimeMs.toString());
  return h.digest("hex").substring(0, 16);
}

async function decodeFor(file: string): Promise<CorpusDecodeResult | null> {
  const layout = analyzeLayout(file);
  if (!layout) { console.warn(`  SKIP ${path.basename(file)}: analyzeLayout failed`); return null; }
  const rl = getCached<RegionLayout>(file, "layout_regions");   // cached only — never fresh Gemini here
  const decode = await decodeReference(file, { layout, regionLayout: rl });
  if (!decode) return null;
  return {
    decode,
    structureTimeline: rl?.structureTimeline ?? null,
    referenceHash: hashOf(file),
    cvVlmAgree: !!rl && (classesAgree(layout.layout.type, rl) || decode.layout.layoutClass.uncertain !== true),
  };
}

async function main() {
  const folder = process.argv[2];
  if (!folder || !fs.existsSync(folder)) { console.error("usage: learn-corpus <folder> [--scores scores.json]"); process.exit(1); }
  const scoresIdx = process.argv.indexOf("--scores");
  const scores: Record<string, Record<string, number>> =
    scoresIdx > 0 && fs.existsSync(process.argv[scoresIdx + 1])
      ? JSON.parse(fs.readFileSync(process.argv[scoresIdx + 1], "utf8")) : {};

  const files = fs.readdirSync(folder)
    .filter((f) => /\.(mp4|mov)$/i.test(f))
    .map((f) => path.join(folder, f));
  console.log(`learn-corpus: ${files.length} reel(s) in ${folder}`);

  const kb = new FileSceneKB();
  const { report, proposals } = await runLearnCorpus({
    files, kb, decodeFor,
    scoreOf: (file, w) => scores[path.basename(file)]?.[`${w.t0.toFixed(1)}-${w.t1.toFixed(1)}`] ?? null,
  });

  // ── report table ──
  console.log("\nfile                                     window        class                 kind        dist   learned");
  for (const reel of report.perReel) {
    for (const s of reel.scenes) {
      console.log(
        `${path.basename(reel.file).padEnd(40)} ${`${s.t0}-${s.t1}s`.padEnd(13)} ${s.layoutClass.padEnd(21)} ` +
        `${s.kind.padEnd(11)} ${s.distance.toFixed(3).padEnd(6)} ${s.learned ? "✓" : ""}`
      );
    }
  }
  console.log(`\ntotals: ${report.totals.scenes} scenes — known ${report.totals.known} / family_new ${report.totals.family_new} / novel ${report.totals.novel} — learned ${report.totals.learned}`);
  const cov = kb.coverageReport();
  console.log(`coverage: ${cov.coveragePct}% KNOWN | per-family: ${JSON.stringify(cov.perFamily)}`);

  const kbDir = path.join(process.cwd(), ".knowledge", "scene-kb");
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, "corpus-report.json"), JSON.stringify({ ...report, totals: { ...report.totals } }, null, 2));
  if (proposals.length) {
    const queuePath = path.join(kbDir, "review-queue.json");
    const existing: unknown[] = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, "utf8")) : [];
    const byHash = new Set((existing as Array<{ referenceHash?: string; window?: { t0: number } }>).map((p) => `${p.referenceHash}_${p.window?.t0}`));
    const fresh = proposals.filter((p) => !byHash.has(`${p.referenceHash}_${p.window.t0}`));
    fs.writeFileSync(queuePath, JSON.stringify([...existing, ...fresh], null, 2));
    console.log(`review queue: ${fresh.length} new novel-family proposal(s) → ${queuePath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
