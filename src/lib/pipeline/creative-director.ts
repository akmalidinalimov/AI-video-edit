/**
 * creative-director.ts — the auto-router, wired for the live pipeline.
 *
 * Reads the narration beats + narrative phases + speech keywords and decides, PER
 * BEAT, which B-roll modality to use (no hardcoded indices). It then RENDERS the
 * motion-graphic clip (programmatic Remotion, content-hash cached) and pins it onto
 * a range of that beat. Footage beats keep their content-matched AI/event clip.
 *
 *   numbers / %       → STAT      (Counter for the count, Donut for the %)
 *   phase = cta       → KINETIC   (CTA clause)
 *   first hook beat   → KINETIC   (hook clause)
 *   phase = solution  → KEN BURNS (cinematic still — if a still is supplied)
 *   else              → FOOTAGE
 *
 * Phase-3 guard: after pinning, no two consecutive ranges share a source.
 * Content note: numbers + labels are auto-extracted; kinetic TEXT uses the real
 * narration clause. An LLM pass (v2) would author punchier copy per beat.
 */
import { renderMgClip } from "./mg-render";
import { defaultMotionStyleFor } from "./motion-design-library";

interface Sentence { index: number; text: string }
interface LayoutRange {
  id: string;
  sentences: Sentence[];
  timeRange: { start: number; end: number };
  brollSourceIndex?: number;
  brollOffset?: number;
  brollKeyframes?: unknown;
}
interface Plan {
  sentences: Sentence[];
  layoutRanges: LayoutRange[];
  sources: { brollClips: Array<{ path: string; duration: number; inputIndex: number }> };
}

export interface CreativeDirectorOpts {
  narrativeContext?: { narrativePhases?: Array<{ phase: string; sentenceIndices: number[] }> } | null;
  speechKeywords?: { sentences?: Array<{ index: number; keywords?: string[] }> } | null;
  /** directory to write rendered MG clips into */
  genDir: string;
  /** public-relative still path used for "concept" (solution) beats; omit to skip Ken Burns */
  kenBurnsStill?: string;
  /** MG style family (default "dark") */
  family?: string;
  /** the reference's dominant B-roll style — biases how much motion-graphics to use */
  referenceStyle?: string;
  /** A-roll word-level transcript — used to place each graphic at the exact spoken word */
  words?: Array<{ word: string; start: number; end: number }>;
  /**
   * The B-roll planner's per-sentence modality decision (the single owner). When a
   * sentence is planned as "none", the planner is telling us to LET THE A-ROLL BREATHE —
   * the creative director then places no motion graphic there. Other values are advisory.
   */
  plannedModalityOf?: Record<number, string>;
  /**
   * B-roll planner slots. Footage slots that already have a generated `clipPath` are
   * pinned into the render at their time range (replacing the matcher's repeated clips).
   */
  brollSlots?: Array<{ modality: string; clipPath?: string; timeRange: { start: number; end: number } }>;
}

function extractStat(text: string): { percent: number | null; count: number | null } {
  const pct = text.match(/(\d{1,3})\s*%/);
  const bigs = [...text.matchAll(/\b(\d{3,})\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => !(n >= 1900 && n <= 2100)); // a year is not a count
  return { percent: pct ? parseInt(pct[1], 10) : null, count: bigs.length ? Math.max(...bigs) : null };
}

/** the first ~6 words of the relevant clause — used as kinetic copy (real narration). */
function kineticText(sentence: string, role: "hook" | "cta"): string {
  if (role === "cta") {
    const m = sentence.match(/([^,.]*\b(?:tugma\w*|bosing|bosib)\b[^,.]*)/i);
    if (m) return m[1].trim().replace(/\s+/g, " ");
  }
  const clause = sentence.split(/[,.]/)[0].trim();
  const words = clause.split(/\s+/);
  return words.length > 7 ? words.slice(0, 6).join(" ") : clause;
}

export async function applyCreativeDirector(
  plan: Plan,
  opts: CreativeDirectorOpts
): Promise<{ pinned: number; routes: string[] }> {
  // The motion-design library picks the graphics' style ONCE per video from the reference
  // class (deliberate, not hardcoded), and maps to an MGCS family. An explicit opts.family
  // still overrides. For a realistic creator ad this resolves to bold_kinetic → "dark".
  const motionStyle = defaultMotionStyleFor(opts.referenceStyle);
  const family = opts.family ?? motionStyle.mgcsFamily;
  if (!opts.family) console.log(`[creative-director] motion-design style: ${motionStyle.id} → MGCS family "${family}"`);
  const phaseOf: Record<number, string> = {};
  for (const p of opts.narrativeContext?.narrativePhases ?? []) for (const i of p.sentenceIndices) phaseOf[i] = p.phase;
  const kwOf: Record<number, string[]> = {};
  for (const s of opts.speechKeywords?.sentences ?? []) kwOf[s.index] = s.keywords ?? [];

  // A footage-dominant reference (realistic people/scenes/product/cartoon) uses
  // little motion-graphics → route the concept beat to FOOTAGE rather than a
  // Ken-Burns still, matching the reference's B-roll style. Stat (numbers need a
  // graphic) and the hook/CTA kinetic accents stay (references still carry ~5–15%
  // text/graphics). Graphics-dominant references keep the Ken-Burns/concept slot.
  const footageDominant = ["realistic_person", "realistic_scene", "product", "cartoon_animation"].includes(
    opts.referenceStyle ?? ""
  );
  if (opts.referenceStyle) console.log(`[creative-director] reference style: ${opts.referenceStyle} (footageDominant=${footageDominant}) — motion graphics kept as a light accent`);

  let hookPlaced = false;
  const routeBeat = (s: Sentence) => {
    // The B-roll planner OWNS the plan: if it marked this beat "none", let the A-roll
    // breathe — no motion graphic here (overrides the cd's own routing).
    if (opts.plannedModalityOf?.[s.index] === "none") return { modality: "footage" } as const;
    const phase = phaseOf[s.index];
    const isCta = phase === "cta" || /\btugma|bosib|bosing\b/i.test(s.text);
    const stat = extractStat(s.text);
    if (stat.count || stat.percent) return { modality: "stat", ...stat } as const;
    if (isCta) return { modality: "kinetic", role: "cta" } as const;
    if ((phase === "hook" || s.index === 0) && !hookPlaced) { hookPlaced = true; return { modality: "kinetic", role: "hook" } as const; }
    if (phase === "solution" && !footageDominant) return { modality: "kenburns" } as const;
    return { modality: "footage" } as const;
  };

  const base = plan.sources.brollClips.length;
  const clipIdx: Record<string, number> = {};
  const addClip = (p: string, knownDurationSec?: number): number => {
    if (clipIdx[p] !== undefined) return clipIdx[p];
    const idx = base + Object.keys(clipIdx).length;
    // Audit fix: duration was hardcoded 3 for every pinned clip. Use the pinned range's real
    // length when known (MG clips are rendered to the range length); 3 remains the fallback.
    plan.sources.brollClips.push({ path: p, duration: knownDurationSec && knownDurationSec > 0 ? knownDurationSec : 3, inputIndex: idx });
    clipIdx[p] = idx;
    return idx;
  };
  const rangesOf = (i: number) => plan.layoutRanges.filter((r) => r.sentences.some((x) => x.index === i));

  // ── Precise placement: pin a graphic to the range CONTAINING the spoken keyword,
  // not the sentence's first/last range. Fixes "the CTA graphic fires 5s before you
  // say 'press the button'". Falls back to the sentence range if the word isn't found.
  const words = opts.words ?? [];
  const rangeAt = (t: number) => plan.layoutRanges.find((r) => t >= r.timeRange.start && t < r.timeRange.end);
  // Find the spoken keyword WITHIN this sentence's time window (so s5's CTA can't
  // grab s4's "tugmani" word), and return the range containing it.
  const rangeForKeyword = (
    re: RegExp,
    fallback: LayoutRange | undefined,
    win?: { start: number; end: number }
  ): LayoutRange | undefined => {
    const w = words.find((x) => re.test(x.word) && (!win || (x.start >= win.start && x.start < win.end)));
    return (w ? rangeAt(w.start) : undefined) ?? fallback;
  };

  const pinnedIds = new Set<string>();
  const pin = (range: LayoutRange | undefined, clipPath: string) => {
    if (!range) return;
    range.brollSourceIndex = addClip(clipPath, range.timeRange.end - range.timeRange.start);
    range.brollOffset = 0;
    range.brollKeyframes = undefined;
    pinnedIds.add(range.id);
  };

  const routes: string[] = [];
  for (const s of plan.sentences) {
    const r = routeBeat(s);
    routes.push(`s${s.index}:${r.modality}${"role" in r ? "/" + r.role : ""}`);
    const rg = rangesOf(s.index);
    if (!rg.length) continue;
    const win = { start: rg[0].timeRange.start, end: rg[rg.length - 1].timeRange.end }; // this sentence's span
    // contextual Uzbek labels: keywords that actually appear in the (Uzbek) sentence
    const uzKw = (kwOf[s.index] ?? []).filter((w) => s.text.toLowerCase().includes(w.toLowerCase()));

    try {
      if (r.modality === "stat") {
        if (r.count) {
          const c = await renderMgClip("data-viz/counter", { intent: s.text, style: { family }, value: r.count, from: 0, value_format: "{n}+", label: uzKw[0] ?? "natija" }, opts.genDir);
          pin(rangeForKeyword(new RegExp("\\b" + r.count + "\\b"), rg[0], win), c.path); // at the spoken number
        }
        if (r.percent) {
          const d = await renderMgClip("data-viz/donut-ring", { intent: s.text, style: { family }, percent: r.percent, label: uzKw[1] ?? uzKw[0] ?? "natija", center_format: "{n}%" }, opts.genDir);
          pin(rangeForKeyword(new RegExp("\\b" + r.percent), rg[rg.length - 1], win), d.path); // at the spoken percent
        }
      } else if (r.modality === "kinetic") {
        const k = await renderMgClip("caption/kinetic", { intent: s.text, style: { family }, text: kineticText(s.text, r.role), mode: "word_by_word", uppercase: r.role === "cta" }, opts.genDir);
        // CTA lands on "pastdagi tugmani bosing" within THIS sentence; the hook stays at the sentence start.
        pin(r.role === "cta" ? rangeForKeyword(/tugma|bosib|bosing|button/i, rg[0], win) : rg[0], k.path);
      } else if (r.modality === "kenburns" && opts.kenBurnsStill) {
        const kb = await renderMgClip("media/ken-burns", { intent: s.text, style: { family }, src: opts.kenBurnsStill, zoom: "in", pan: "right" }, opts.genDir);
        pin(rg[0], kb.path);
      }
    } catch (err) {
      console.error(`[creative-director] render failed for s${s.index} (${r.modality}):`, err);
    }
  }

  // ── Pin GENERATED footage clips (B-roll planner slots with a clipPath) to footage
  // ranges, matched by time. With MMS timing, slot + range times agree, so each beat's
  // generated clip lands on the right shot — replacing the matcher's repeated clips. ──
  let footagePinned = 0;
  for (const range of plan.layoutRanges) {
    if (pinnedIds.has(range.id)) continue; // keep the motion-graphic pins
    const mid = (range.timeRange.start + range.timeRange.end) / 2;
    const slot = (opts.brollSlots ?? []).find(
      (s) => s.modality === "ai_footage" && s.clipPath && mid >= s.timeRange.start && mid < s.timeRange.end
    );
    if (slot?.clipPath) { pin(range, slot.clipPath); footagePinned++; }
  }
  if (footagePinned) console.log(`[creative-director] pinned ${footagePinned} generated footage clip(s) to ranges`);

  // ── Phase 3: no two consecutive ranges share a source (reassign non-pinned dupes) ──
  let prev = -1;
  for (const r of plan.layoutRanges) {
    const src = r.brollSourceIndex ?? 0;
    if (src === prev && !pinnedIds.has(r.id)) {
      const alt = plan.sources.brollClips.findIndex((_, i) => i !== prev && i < base);
      if (alt >= 0) { r.brollSourceIndex = alt; r.brollOffset = 0; }
    }
    prev = r.brollSourceIndex ?? 0;
  }

  return { pinned: pinnedIds.size, routes };
}
