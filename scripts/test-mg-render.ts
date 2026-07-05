/** Verify programmatic MG rendering (bundle once → renderMedia) works server-side. */
import path from "node:path";
import { renderMgClip } from "../src/lib/pipeline/mg-render";

void (async () => {
  const outDir = path.join(process.cwd(), "public/uploads/generated/mg-auto");
  const t0 = Date.now();
  const r1 = await renderMgClip(
    "data-viz/counter",
    { intent: "test 1500", style: { family: "dark" }, value: 1500, from: 0, value_format: "{n}+", label: "o'quvchi" },
    outDir
  );
  console.log(`counter: ${r1.path} (cached=${r1.cached}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const t1 = Date.now();
  const r2 = await renderMgClip(
    "caption/kinetic",
    { intent: "test cta", style: { family: "dark" }, text: "Pastdagi tugmani bosing", mode: "word_by_word", uppercase: true },
    outDir
  );
  console.log(`kinetic: ${r2.path} (cached=${r2.cached}) in ${((Date.now() - t1) / 1000).toFixed(1)}s  (2nd render reuses the bundle)`);
})().catch((e) => { console.error(e); process.exit(1); });
