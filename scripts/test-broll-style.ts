/** Classify the reference video's B-roll STYLE + show the mapped modality + guidance. */
import fs from "node:fs";
import path from "node:path";
const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
void (async () => {
  const { classifyReferenceBrollStyle, STYLE_TO_MODALITY, STYLE_PROMPT_GUIDANCE } = await import(
    "../src/lib/pipeline/broll-style"
  );
  const ref = path.join(process.cwd(), "public/uploads/1782174583392_target_2split.mp4");
  console.log("Classifying B-roll style of:", ref, fs.existsSync(ref) ? "(exists)" : "(MISSING)");
  const r = await classifyReferenceBrollStyle(ref);
  if (!r) { console.error("classification returned null"); process.exit(1); }
  console.log("\nDOMINANT:", r.dominant, "→ modality:", STYLE_TO_MODALITY[r.dominant]);
  console.log("MIX:", r.styles.map((s) => `${s.style} ${Math.round(s.share * 100)}%`).join(", "));
  console.log("REASON:", r.reason);
  console.log("GUIDANCE:", STYLE_PROMPT_GUIDANCE[r.dominant]);
})().catch((e) => { console.error(e); process.exit(1); });
