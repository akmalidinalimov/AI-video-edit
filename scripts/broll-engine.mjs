/**
 * broll-engine.mjs — COST-AWARE B-roll router + stock fetcher (planner).
 *
 * Decides, per B-roll beat, the cheapest CAPABLE source and emits a resolved plan with a cost
 * estimate. It does NOT spend credits: GENERATED beats are emitted as MCP `generate_video`
 * directives that the in-session orchestrator (style-director) executes + gates; STOCK beats are
 * fetched here from Pexels (free) when a key is present. This is the "improve B-roll" engine: when
 * the reference HAS b-roll to match, route to the right tool; when the user has NONE, generate it.
 *
 * Routing (cheapest capable first) — see the plan + docs/broll-generation.md:
 *   1. STOCK (Pexels free / Storyblocks)  — real-human / common-subject shots (AI weakest there)
 *   2. KLING 3.0 @1080p  (DEFAULT generate) — ~$0.112/s; image-to-video start/end + camera prompt
 *   3. SEEDANCE 2.0 @720p (GATED fallback)  — ~$0.242/s; ONLY when beat.needsVideoReference (literal
 *      reference-clip composition replication — the one thing Seedance is meaningfully better at)
 *
 * Usage:
 *   node scripts/broll-engine.mjs <directives.json> [--dry-run] [--out plan.json] [--stock-dir DIR]
 *   <directives.json> = a BRollDirective[] (see scripts/lib/broll/contract.mjs) OR { directives:[...] }
 *   --dry-run : route + cost only; do NOT fetch stock or emit generation directives' media
 *
 * Writes <out> (default broll-plan.json next to input): { beats:[resolved], totals:{...} } and prints
 * a routing table + total estimated cost (no silent caps — every routing decision is logged).
 */
import fs from "fs";
import path from "path";
import { normalizeDirective, validateDirective } from "./lib/broll/contract.mjs";

const ROOT = process.cwd();
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(f);
const inFile = process.argv[2];
if (!inFile || inFile.startsWith("--")) {
  console.error("usage: node scripts/broll-engine.mjs <directives.json> [--dry-run] [--out plan.json] [--stock-dir DIR]");
  process.exit(1);
}
const DRY = has("--dry-run");
const OUT = path.resolve(ROOT, arg("--out", path.join(path.dirname(path.resolve(ROOT, inFile)), "broll-plan.json")));
const STOCK_DIR = path.resolve(ROOT, arg("--stock-dir", "public/uploads/gen/broll/stock"));

// ── cost model (USD/sec) from June-2026 research; Kling cheapest-capable default ──
const COST = {
  stock: 0,                        // Pexels free (Storyblocks if licensed)
  kling3_0: { "1080p": 0.112, "4k": 0.20, "720p": 0.09 }, // 10s@1080p ≈ $1.12
  seedance_2_0: { "720p": 0.242, "1080p": 0.303 },        // fast 10s ≈ $2.42 ; gated, 720p to cap cost
};

function loadEnv() {
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

// Real-human / common-subject beats → STOCK wins (AI still weakest on photoreal humans).
const STOCK_HINTS = /\b(person|people|woman|man|men|women|crowd|customer|team|office|handshake|walking|smiling|talking|face|portrait|hands?|family|child|kids?|chef|doctor|worker|driver|street|city|nature|ocean|forest|sunset|coffee shop|restaurant)\b/i;

/** Decide the source + model + resolution + est cost for one beat. */
export function routeBeat(beat) {
  const dur = beat.durationSec || 3;
  // explicit overrides from the Analyst take priority
  if (beat.kind === "stock" || beat.realFootage === true || (beat.concept && STOCK_HINTS.test(`${beat.concept} ${beat.prompt || ""}`) && !beat.needsVideoReference && beat.realFootage !== false)) {
    return { ...beat, source: "stock", model: undefined, resolution: undefined, estCostUsd: 0, reason: beat.realFootage === true ? "flagged realFootage" : (beat.kind === "stock" ? "kind=stock" : "real-human/common subject → stock cheaper & more photoreal") };
  }
  if (beat.needsVideoReference === true) {
    const resolution = "720p";
    return { ...beat, source: "generate", model: "seedance_2_0", resolution, estCostUsd: +(COST.seedance_2_0[resolution] * dur).toFixed(3), reason: "needsVideoReference → Seedance 2.0 (only model with video-ref), 720p to cap cost" };
  }
  // DEFAULT: Kling 3.0 @1080p (matches/beats Seedance on motion+camera at ~half cost)
  const resolution = beat.resolution === "4k" ? "4k" : "1080p";
  return { ...beat, source: "generate", model: "kling3_0", resolution, estCostUsd: +(COST.kling3_0[resolution] * dur).toFixed(3), reason: "default — Kling 3.0 does motion/camera/multi-shot at ~½ Seedance cost" };
}

/** Fetch a candidate stock clip from Pexels (free). Returns {file, url, credit} or null. */
export async function fetchStock(query, { perPage = 5, idx = 0 } = {}) {
  loadEnv();
  const key = process.env.PEXELS_API_KEY;
  if (!key) return { error: "no PEXELS_API_KEY in .env.local — set it to enable stock fetch", query };
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=portrait`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) return { error: `Pexels ${res.status}`, query };
  const data = await res.json();
  const vid = (data.videos || [])[idx];
  if (!vid) return { error: "no Pexels result", query };
  // pick an HD-ish portrait file
  const f = (vid.video_files || []).sort((a, b) => (b.height || 0) - (a.height || 0)).find(v => (v.height || 0) >= 1080) || (vid.video_files || [])[0];
  if (!f) return { error: "no video file", query };
  fs.mkdirSync(STOCK_DIR, { recursive: true });
  const dest = path.join(STOCK_DIR, `pexels_${vid.id}.mp4`);
  const bin = Buffer.from(await (await fetch(f.link)).arrayBuffer());
  fs.writeFileSync(dest, bin);
  return { file: path.relative(ROOT, dest), url: vid.url, credit: `Video by ${vid.user?.name} on Pexels`, width: f.width, height: f.height };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, inFile), "utf-8"));
  const directives = Array.isArray(raw) ? raw : (raw.directives || [raw]);
  const resolved = [];
  let total = 0; const bySource = { stock: 0, kling3_0: 0, seedance_2_0: 0 };

  for (const d0 of directives) {
    const d = validateDirective(d0).ok ? d0 : normalizeDirective(d0, d0.segId ?? 0, 0);
    const rawBeats = Array.isArray(d0.beats) ? d0.beats : [];
    const beats = d.beats || [];
    for (let bi = 0; bi < beats.length; bi++) {
      const beat = beats[bi];
      // normalizeBeat() drops routing flags not in the contract — merge them back from the raw beat
      const raw = rawBeats[bi] || {};
      for (const k of ["needsVideoReference", "realFootage", "resolution"]) if (raw[k] !== undefined) beat[k] = raw[k];
      const r = routeBeat(beat);
      total += r.estCostUsd || 0;
      bySource[r.source === "stock" ? "stock" : r.model] = (bySource[r.source === "stock" ? "stock" : r.model] || 0) + 1;
      // STOCK: fetch now (free) unless dry-run
      if (r.source === "stock" && !DRY) {
        const stock = await fetchStock(r.concept || r.prompt || d.strategy || "lifestyle");
        r.stock = stock;
        if (stock?.error) r.note = `stock fetch: ${stock.error} (orchestrator should generate as fallback)`;
      }
      resolved.push({ segId: d.segId, ...r });
      console.log(`  seg${d.segId} beat${r.order} ${(r.durationSec || 3).toFixed(1)}s → ${r.source === "stock" ? "STOCK" : r.model + "@" + r.resolution}  $${(r.estCostUsd || 0).toFixed(2)}  — ${r.reason}`);
    }
  }

  const plan = { generatedAt: null, dryRun: DRY, beats: resolved, totals: { count: resolved.length, estCostUsd: +total.toFixed(2), bySource } };
  fs.writeFileSync(OUT, JSON.stringify(plan, null, 2));
  console.log(`\n  ${resolved.length} beats — est cost $${total.toFixed(2)}  (${JSON.stringify(bySource)})`);
  console.log(`  plan: ${path.relative(ROOT, OUT)}${DRY ? "  [DRY-RUN: no stock fetched, no credits spent]" : ""}`);
  console.log(`  NOTE: generation directives are executed by the style-director orchestrator via MCP generate_video, then cleanliness + relevance gated.`);
}

main().catch(e => { console.error(e); process.exit(1); });
