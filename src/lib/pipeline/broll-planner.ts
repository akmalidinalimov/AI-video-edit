/**
 * broll-planner.ts — STEP 2 of the deliberate B-roll planning pipeline.
 *
 * The single OWNER of the B-roll plan. Instead of scattering "when / how long / what
 * treatment / where / what about" across plan-builder + creative-director + narrative
 * analyzer, this module produces ONE explicit, inspectable B-roll PLAN: an ordered list
 * of slots, each one a deliberate decision — not a random clip dropped on a sentence.
 *
 * For each narration beat it decides:
 *   WHEN + HOW LONG  → cadence-driven slots (Step 1), anchored to the spoken keyword (MMS times)
 *   MODALITY         → ai_footage | motion_graphic | stat | stock | none  (the treatment)
 *   WHERE            → fullscreen | split | circle  (from the reference layout)
 *   WHAT             → a short concept brief + the keyword to highlight
 *
 * The concept brief is produced by a pluggable conceptFn (default heuristic; later an
 * LLM "B-roll director" or the visual-treatment KB plugs in here). Step 3's prompt engine
 * expands a slot's concept into a full Kling prompt. Pure + deterministic core → testable.
 */
import { type CadencePlan, estimateShots, planCadence } from "./cadence-planner";

export type Modality = "ai_footage" | "motion_graphic" | "stat" | "stock" | "none";
export type BrollLayout = "fullscreen" | "split" | "circle";

export interface PlanBeat { index: number; text: string; start: number; end: number }
export interface PlanWord { word: string; start: number; end: number }

export interface BrollSlot {
  id: string;
  beatIndex: number;
  timeRange: { start: number; end: number };
  durationSec: number;
  modality: Modality;
  layout: BrollLayout;
  /** the spoken keyword this slot lands on (the thing to highlight) */
  keyword?: string;
  /** short brief of WHAT the B-roll should show (expanded into a prompt in Step 3) */
  concept: string;
  /** why this treatment was chosen — keeps every slot deliberate, auditable */
  rationale: string;
  /** Step 3: the generated Kling prompt for ai_footage slots (filled by the prompt engine) */
  prompt?: string;
  negative?: string;
  /** Step 4: the generated clip file for this footage slot (filled after generation) — pinned into the render */
  clipPath?: string;
  /** region-fit aspect to GENERATE at (from the framing planner) so the head isn't cropped */
  generateAspect?: string;
}

export interface BrollPlan {
  slots: BrollSlot[];
  /** every beat's modality decision, INCLUDING "none" (which produces no slot) */
  modalityByBeat: Record<number, Modality>;
  summary: {
    total: number;
    byModality: Record<Modality, number>;
    coveragePct: number; // % of the timeline covered by a non-"none" B-roll slot
    cadenceSource: string;
    targetShotSec: number;
  };
}

export interface BrollPlanInput {
  beats: PlanBeat[];
  words?: PlanWord[];                         // MMS word times → keyword anchoring
  keywordsOf?: Record<number, string[]>;      // per-beat keywords (highlight candidates)
  phaseOf?: Record<number, string>;           // per-beat narrative phase (hook/solution/cta…)
  cadence: CadencePlan;                        // Step 1 output
  referenceStyle?: string;                     // realistic_person etc. → footage-dominant?
  layoutOf?: (beatIndex: number) => BrollLayout; // WHERE, from the reference template
  conceptFn?: (beat: PlanBeat, keyword: string | undefined, modality: Modality) => string; // SEAM: LLM/KB later
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'%]/gu, "");
const FOOTAGE_STYLES = ["realistic_person", "realistic_scene", "product", "cartoon_animation"];
const CTA_RE = /\b(tugma\w*|bosib|bosing|button|click|pastdagi|link)\b/i;

/** Numbers/percentages that warrant a stat graphic (ignore years like 2026). */
function hasStat(text: string): boolean {
  if (/\d{1,3}\s*%/.test(text)) return true;
  return [...text.matchAll(/\b(\d{3,})\b/g)].some((m) => {
    const n = parseInt(m[1], 10);
    return !(n >= 1900 && n <= 2100);
  });
}

/** The deliberate treatment decision for a beat. */
export function decideModality(beat: PlanBeat, phase: string | undefined, style: string | undefined): { modality: Modality; rationale: string } {
  const footageDominant = FOOTAGE_STYLES.includes(style ?? "realistic_person");
  if (hasStat(beat.text)) return { modality: "stat", rationale: "beat states a number/percentage → animated stat graphic" };
  if (phase === "cta" || CTA_RE.test(beat.text)) return { modality: "motion_graphic", rationale: "call-to-action → kinetic text graphic" };
  if (phase === "hook" || beat.index === 0) return { modality: "ai_footage", rationale: "hook beat → aspirational footage (matches reference open)" };
  if ((phase === "solution" || phase === "concept") && !footageDominant) return { modality: "motion_graphic", rationale: "concept beat, graphics-dominant reference → motion graphic" };
  // very short non-special beats: let the A-roll breathe rather than force a clip
  if (beat.end - beat.start < 1.2) return { modality: "none", rationale: "beat too short for a meaningful B-roll → hold on A-roll" };
  return { modality: footageDominant ? "ai_footage" : "motion_graphic", rationale: footageDominant ? "body beat, footage-dominant reference → AI footage" : "body beat, graphics reference → motion graphic" };
}

/** Find the keyword spoken inside [start,end): prefer a listed keyword, else the longest word. */
function anchorKeyword(start: number, end: number, words: PlanWord[], beatKeywords: string[]): string | undefined {
  const inWin = words.filter((w) => w.start >= start - 0.05 && w.start < end);
  if (!inWin.length) return beatKeywords[0];
  const kset = new Set(beatKeywords.map(norm).filter((k) => k.length >= 3));
  const hit = inWin.find((w) => kset.has(norm(w.word)));
  if (hit) return hit.word;
  // else the most "content-y" word in the window (longest, ignoring tiny stopwords)
  const content = inWin.filter((w) => norm(w.word).length >= 4).sort((a, b) => norm(b.word).length - norm(a.word).length);
  return content[0]?.word ?? beatKeywords[0];
}

function defaultConcept(beat: PlanBeat, keyword: string | undefined, modality: Modality): string {
  const gist = beat.text.replace(/\s+/g, " ").trim().slice(0, 70);
  if (modality === "stat") return `stat graphic for "${keyword ?? "the number"}" — ${gist}`;
  if (modality === "motion_graphic") return `kinetic text emphasizing "${keyword ?? gist}"`;
  return `footage evoking "${keyword ?? gist}"`;
}

export function planBroll(input: BrollPlanInput): BrollPlan {
  const { beats, cadence } = input;
  const words = input.words ?? [];
  const layoutOf = input.layoutOf ?? (() => "split" as BrollLayout);
  const conceptFn = input.conceptFn ?? defaultConcept;
  const slots: BrollSlot[] = [];
  const modalityByBeat: Record<number, Modality> = {};

  for (const beat of beats) {
    const phase = input.phaseOf?.[beat.index];
    const beatKeywords = input.keywordsOf?.[beat.index] ?? [];
    const { modality, rationale } = decideModality(beat, phase, input.referenceStyle);
    modalityByBeat[beat.index] = modality;
    if (modality === "none") continue;

    // graphics occupy the whole beat; footage is cut into a cadence-driven montage
    const span = beat.end - beat.start;
    const nShots = modality === "ai_footage" ? estimateShots(span, cadence) : 1;
    const shotDur = span / nShots;

    for (let k = 0; k < nShots; k++) {
      const start = beat.start + k * shotDur;
      const end = k === nShots - 1 ? beat.end : beat.start + (k + 1) * shotDur;
      const keyword = anchorKeyword(start, end, words, beatKeywords);
      slots.push({
        id: `slot_${beat.index}_${k}`,
        beatIndex: beat.index,
        timeRange: { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 },
        durationSec: Math.round(shotDur * 1000) / 1000,
        modality,
        layout: layoutOf(beat.index),
        keyword,
        concept: conceptFn(beat, keyword, modality),
        rationale,
      });
    }
  }

  const totalDur = beats.length ? beats[beats.length - 1].end - beats[0].start : 0;
  const covered = slots.reduce((a, s) => a + (s.timeRange.end - s.timeRange.start), 0);
  const byModality = slots.reduce((acc, s) => { acc[s.modality] = (acc[s.modality] ?? 0) + 1; return acc; }, {} as Record<Modality, number>);

  return {
    slots,
    modalityByBeat,
    summary: {
      total: slots.length,
      byModality,
      coveragePct: totalDur > 0 ? Math.round((covered / totalDur) * 1000) / 10 : 0,
      cadenceSource: cadence.source,
      targetShotSec: cadence.targetShotSec,
    },
  };
}
