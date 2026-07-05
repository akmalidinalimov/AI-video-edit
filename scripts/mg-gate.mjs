/**
 * mg-gate.mjs — the Motion-Graphics Component System perfection gate (static pass).
 *
 * Verifies — rather than trusts — the rules every component must obey
 * (docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2.5). Pure Node, no deps.
 *
 *   node scripts/mg-gate.mjs            # gate every component
 *   node scripts/mg-gate.mjs <file>     # gate one file
 *
 * Exit 0 = all gated. Exit 1 = at least one ERROR. Warnings never block.
 *
 * NOTE: this is the STATIC pass (source heuristics). The DYNAMIC pass
 * (bundle-compile + golden render of every component via MG-Preview) is run
 * separately; together they form the full gate. Heuristics are intentionally
 * conservative — a flagged line is a prompt to look, not always a defect.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/remotion/motion/components");
const ALLOWED_IMPORTS = [/^react$/, /^remotion$/, /^zod$/, /^(\.\.\/)+(contract|tokens|types)(\/index)?$/];
const LAYOUT_PROPS = ["top", "left", "right", "bottom", "width", "height"];
const ANIM_TOKENS = /(interpolate\(|spring\(|\bframe\b|\bcountT\b|\bgrow\b|\bsweep\b|\bprogress\b)/;

const C = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, gray: (s) => `\x1b[90m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function lint(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const v = [];
  const err = (code, line, msg) => v.push({ sev: "error", code, line, msg });
  const warn = (code, line, msg) => v.push({ sev: "warn", code, line, msg });

  // R1 — allowed imports only
  lines.forEach((ln, i) => {
    const m = ln.match(/^\s*import\b[^'"]*from\s*["']([^"']+)["']/);
    if (m) {
      const spec = m[1];
      if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) err("IMPORT_NOT_ALLOWED", i + 1, `import from "${spec}" is outside the allowed set (react, remotion, zod, ../../{contract,tokens,types})`);
    }
  });

  // R2 — reduceMotion must be read & branched on in the render
  if (!/\binput\.reduceMotion\b/.test(src) && !/\breduceMotion\b/.test(src.replace(/reduceMotion\?\s*:/g, ""))) {
    err("REDUCE_MOTION_IGNORED", 0, "component never reads input.reduceMotion — accessibility/low-motion variant not honored");
  }

  // R3 — motion floor: ≥3 animation drivers (interpolate/spring calls)
  const drivers = (src.match(/\b(interpolate|spring)\(/g) || []).length;
  if (drivers < 3) err("MOTION_FLOOR", 0, `only ${drivers} animation driver(s) (interpolate/spring); need ≥3 simultaneous layers`);

  // R4 — hardware-accelerated movement only: no animated top/left/right/bottom/width/height
  lines.forEach((ln, i) => {
    for (const p of LAYOUT_PROPS) {
      const re = new RegExp(`\\b${p}\\s*:\\s*[^,}\\n]*`);
      const mm = ln.match(re);
      if (mm && ANIM_TOKENS.test(mm[0])) err("NON_HW_ACCEL", i + 1, `animating layout prop "${p}" (triggers reflow). Use transform/opacity. → ${ln.trim().slice(0, 70)}`);
    }
  });

  // R5 — inline styles only (no Tailwind classNames in rendered graphics)
  lines.forEach((ln, i) => { if (/className\s*=/.test(ln)) warn("CLASSNAME_USED", i + 1, "className found — motion graphics should use inline styles (Remotion renders inline)"); });

  // R6 — descriptor completeness
  for (const field of ["id:", "category:", "status:", "inputSchema:", "Render:", "defaults:", "specialistId:"]) {
    if (!src.includes(field)) err("DESCRIPTOR_INCOMPLETE", 0, `MotionComponent descriptor missing "${field}"`);
  }
  if (/status:\s*["']production["']/.test(src) === false) warn("NOT_PRODUCTION", 0, "status is not \"production\" (draft/gated won't be auto-used by the Composer)");

  // R7 — defaults() bbox should keep content out of IG safe zones (top 0.151 / bottom 0.78)
  const bbox = src.match(/bbox_norm:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
  if (bbox) {
    const y = parseFloat(bbox[2]); const h = parseFloat(bbox[4]);
    if (y < 0.151) warn("SAFE_ZONE_TOP", 0, `defaults bbox top y=${y} enters the top safe band (<0.151)`);
    if (y + h > 0.78) warn("SAFE_ZONE_BOTTOM", 0, `defaults bbox bottom y+h=${(y + h).toFixed(3)} enters the bottom safe band (>0.78)`);
  }

  return v;
}

const files = process.argv[2] ? [path.resolve(process.argv[2])] : walk(ROOT);
let errors = 0, warnings = 0;
console.log(C.bold("\nMotion-Graphics Gate — static pass\n"));
for (const f of files) {
  const v = lint(f);
  const e = v.filter((x) => x.sev === "error").length;
  const w = v.filter((x) => x.sev === "warn").length;
  errors += e; warnings += w;
  const tag = e ? C.red("FAIL") : w ? C.yellow("WARN") : C.green("PASS");
  console.log(`${tag}  ${path.relative(process.cwd(), f)}  ${C.gray(`(${e} err, ${w} warn)`)}`);
  for (const x of v) {
    const loc = x.line ? C.gray(`L${x.line}`) : C.gray("—");
    const code = x.sev === "error" ? C.red(x.code) : C.yellow(x.code);
    console.log(`      ${loc}  ${code}  ${x.msg}`);
  }
}
console.log(`\n${C.bold("Summary")}: ${files.length} component(s) · ${errors ? C.red(errors + " error(s)") : C.green("0 errors")} · ${warnings} warning(s)\n`);
process.exit(errors ? 1 : 0);
