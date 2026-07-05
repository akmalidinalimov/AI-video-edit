/**
 * scene-kb.ts — [3] SceneKB MATCH + [5] LEARN (scene-KB spec §3.2).
 *
 * Hybrid KB: parametric FAMILIES (curated, human-admitted — .knowledge/scene-kb/families.json)
 * + verified EXEMPLARS (auto-learned, score-gated — exemplars/<family>/<id>.json).
 * MEASUREMENTS ONLY, never footage (copyright-safe by construction; no PII; content-hash keyed).
 *
 * Matching: family filter by layoutClass → weighted nearest-exemplar distance
 * (geometry 0.5, pacing 0.25, captions 0.15, motion 0.10); KNOWN ⇔ distance ≤ 0.12.
 * Learning gates (poisoning defenses, spec §4): windowed closed-loop score ≥ 95 AND
 * CV/VLM class agreement AND dedup by (referenceHash, window). Novel families are
 * NEVER auto-admitted — proposeFamily() drafts a human-queue proposal.
 *
 * File-backed store v1; the SceneKB interface is backend-swappable (Postgres at M4).
 */
import fs from "fs";
import path from "path";
import type { ReferenceDecode, DecodedRegion } from "@/lib/analysis/reference-decode";

export const KNOWN_DISTANCE = 0.12;
export const LEARN_SCORE_MIN = 95;
export const ENGINE_VERSION = "scene-kb-v1";

// ── weights (spec §3.2) ──
const W_GEOMETRY = 0.5, W_PACING = 0.25, W_CAPTIONS = 0.15, W_MOTION = 0.10;

export interface DecodedScene {
  window: { t0: number; t1: number };
  layoutClass: string;
  regions: DecodedRegion[];
  /** window-scoped decode (windowDecode output) — pacing/captions/motion source. */
  decode: ReferenceDecode;
  referenceHash: string;
}

export interface SceneExemplar {
  id: string;
  family: string;
  referenceHash: string;
  window: { t0: number; t1: number };
  /** fractional geometry — measurements, never footage */
  geometry: DecodedRegion[];
  pacing: { shotCount: number; avgShotSec: number; cutFrequency: string };
  captions: { present: boolean; position: string | null };
  motion: { dominant: string; distribution: Record<string, number> };
  renderParams?: Record<string, unknown>;
  closedLoopScore: number;
  provenance: { sourceFile?: string; createdAt: string; engineVersion: string };
}

export interface SceneMatch {
  kind: "known" | "family_new" | "novel";
  family: string | null;
  exemplar?: SceneExemplar;
  distance: number;   // 1 when no family/exemplar to compare against
}

export interface FamilyRecipe {
  familyId: string;
  decodeRecipe: { extractors: string[]; thresholds: Record<string, number> };
  renderRecipe: { templatePath: string; compositor: string; paramMap: Record<string, string> };
  /** merged from the exemplar when getRecipe(family, exemplarId) resolves one */
  renderParams?: Record<string, unknown>;
}

export interface ExemplarCandidate {
  scene: DecodedScene;
  renderParams?: Record<string, unknown>;
  /** windowed closed-loop [D] score for this scene's window (0..100) */
  closedLoopScore: number;
  /** CV/VLM class agreement for this reference (classesAgree / non-uncertain layoutClass) */
  cvVlmAgree: boolean;
  sourceFile?: string;
}

export interface LearnResult { learned: boolean; reason: string; exemplarId?: string }

export interface FamilyProposal {
  proposedId: string;
  layoutClass: string;
  regions: DecodedRegion[];
  referenceHash: string;
  window: { t0: number; t1: number };
  createdAt: string;
}

export interface CoverageStats {
  totalScenes: number;
  known: number;
  familyNew: number;
  novel: number;
  coveragePct: number;
  perFamily: Record<string, { exemplars: number; avgScore: number }>;
}

export interface SceneKB {
  matchScene(scene: DecodedScene): SceneMatch;
  getRecipe(family: string, exemplarId?: string): FamilyRecipe | null;
  learnExemplar(e: ExemplarCandidate): LearnResult;
  proposeFamily(scene: DecodedScene): FamilyProposal;
  coverageReport(): CoverageStats;
}

interface FamilyEntry {
  id: string;
  layoutClass: string;
  signature: Record<string, unknown>;
  decodeRecipe: FamilyRecipe["decodeRecipe"];
  renderRecipe: FamilyRecipe["renderRecipe"];
}
interface FamiliesFile { version: number; note?: string; knownDistanceThreshold?: number; families: FamilyEntry[] }

// ── distance components (all 0..1) ──

const rectDist = (a: DecodedRegion["rect"], b: DecodedRegion["rect"]) =>
  (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h)) / 4;

function geometryDistance(a: DecodedRegion[], b: DecodedRegion[]): number {
  const roles = new Set([...a.map((r) => r.role), ...b.map((r) => r.role)]);
  if (!roles.size) return 0;
  let sum = 0;
  for (const role of roles) {
    const ra = a.find((r) => r.role === role), rb = b.find((r) => r.role === role);
    // ×7.0: calibrated for KNOWN boundary at 0.12 distance. Semantic anchors:
    // 1.5% rect drift (divider 0.56→0.575) → ≈0.053 final distance (KNOWN);
    // 10% rect drift (divider 0.56→0.66) → ≈0.175 final distance (family_new).
    sum += ra && rb ? Math.min(1, rectDist(ra.rect, rb.rect) * 7.0) : 1;
  }
  return sum / roles.size;
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) { const x = a[k] ?? 0, y = b[k] ?? 0; dot += x * y; na += x * x; nb += y * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : (na === 0 && nb === 0 ? 1 : 0);
}

/** Weighted distance scene↔exemplar (spec §3.2): geometry .5, pacing .25, captions .15, motion .10. */
export function sceneDistance(scene: DecodedScene, ex: SceneExemplar): number {
  const d = scene.decode;
  const g = geometryDistance(scene.regions, ex.geometry);
  const aShot = d.pacing.avgShotSec.value, bShot = ex.pacing.avgShotSec;
  const p = Math.min(1, Math.abs(aShot - bShot) / Math.max(aShot, bShot, 0.5));
  const c = d.captions.present.value !== ex.captions.present ? 1
    : (d.captions.position.value ?? null) !== ex.captions.position ? 0.5 : 0;
  const m = 1 - cosine(d.motion.distribution.value, ex.motion.distribution);
  const dist = W_GEOMETRY * g + W_PACING * p + W_CAPTIONS * c + W_MOTION * m;
  return Math.round(dist * 10000) / 10000;
}

const exemplarId = (referenceHash: string, w: { t0: number; t1: number }) =>
  `${referenceHash}_${w.t0.toFixed(1)}-${w.t1.toFixed(1)}`.replace(/[^a-zA-Z0-9_.-]/g, "_");

/** File-backed SceneKB v1 — rootDir defaults to .knowledge/scene-kb/ (spec §3.2). */
export class FileSceneKB implements SceneKB {
  constructor(private rootDir: string = path.join(process.cwd(), ".knowledge", "scene-kb")) {}

  private familiesPath() { return path.join(this.rootDir, "families.json"); }
  private exemplarDir(family: string) { return path.join(this.rootDir, "exemplars", family); }

  private loadFamilies(): FamilyEntry[] {
    try { return (JSON.parse(fs.readFileSync(this.familiesPath(), "utf8")) as FamiliesFile).families ?? []; }
    catch { return []; }
  }

  private loadExemplars(family: string): SceneExemplar[] {
    try {
      const dir = this.exemplarDir(family);
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SceneExemplar);
    } catch { return []; }
  }

  private familyFor(layoutClass: string): FamilyEntry | null {
    return this.loadFamilies().find((f) => f.layoutClass === layoutClass) ?? null;
  }

  matchScene(scene: DecodedScene): SceneMatch {
    const family = this.familyFor(scene.layoutClass);
    if (!family) return { kind: "novel", family: null, distance: 1 };
    const exemplars = this.loadExemplars(family.id);
    if (!exemplars.length) return { kind: "family_new", family: family.id, distance: 1 };
    let best: SceneExemplar = exemplars[0], bestD = sceneDistance(scene, exemplars[0]);
    for (const ex of exemplars.slice(1)) {
      const d = sceneDistance(scene, ex);
      if (d < bestD) { best = ex; bestD = d; }
    }
    return bestD <= KNOWN_DISTANCE
      ? { kind: "known", family: family.id, exemplar: best, distance: bestD }
      : { kind: "family_new", family: family.id, distance: bestD };
  }

  getRecipe(family: string, exemplarIdArg?: string): FamilyRecipe | null {
    const f = this.loadFamilies().find((x) => x.id === family);
    if (!f) return null;
    const recipe: FamilyRecipe = { familyId: f.id, decodeRecipe: f.decodeRecipe, renderRecipe: f.renderRecipe };
    if (exemplarIdArg) {
      const ex = this.loadExemplars(family).find((e) => e.id === exemplarIdArg);
      if (ex?.renderParams) recipe.renderParams = ex.renderParams;
    }
    return recipe;
  }

  learnExemplar(e: ExemplarCandidate): LearnResult {
    // ── admission gates (spec §4 — extends the proven poisoning defenses) ──
    if (e.closedLoopScore < LEARN_SCORE_MIN)
      return { learned: false, reason: `windowed closed-loop score ${e.closedLoopScore} < ${LEARN_SCORE_MIN}` };
    if (!e.cvVlmAgree)
      return { learned: false, reason: "CV/VLM class agreement required — disagreement ⇒ human confirm" };
    const family = this.familyFor(e.scene.layoutClass);
    if (!family)
      return { learned: false, reason: `novel family "${e.scene.layoutClass}" — never auto-admitted (human queue)` };
    const id = exemplarId(e.scene.referenceHash, e.scene.window);
    const file = path.join(this.exemplarDir(family.id), `${id}.json`);
    if (fs.existsSync(file))
      return { learned: false, reason: `duplicate (referenceHash, window) — ${id} already admitted` };
    const d = e.scene.decode;
    const ex: SceneExemplar = {
      id,
      family: family.id,
      referenceHash: e.scene.referenceHash,
      window: { ...e.scene.window },
      geometry: e.scene.regions.map((r) => ({ ...r, rect: { ...r.rect } })),
      pacing: { shotCount: d.pacing.shotCount.value, avgShotSec: d.pacing.avgShotSec.value, cutFrequency: d.pacing.cutFrequency.value },
      captions: { present: d.captions.present.value, position: d.captions.position.value ?? null },
      motion: { dominant: d.motion.dominant.value, distribution: { ...d.motion.distribution.value } },
      ...(e.renderParams ? { renderParams: e.renderParams } : {}),
      closedLoopScore: e.closedLoopScore,
      provenance: { sourceFile: e.sourceFile, createdAt: new Date().toISOString(), engineVersion: ENGINE_VERSION },
    };
    try {
      fs.mkdirSync(this.exemplarDir(family.id), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(ex, null, 2));
    } catch (err) {
      return { learned: false, reason: `store write failed: ${(err as Error).message}` };
    }
    return { learned: true, reason: "gated exemplar admitted", exemplarId: id };
  }

  proposeFamily(scene: DecodedScene): FamilyProposal {
    return {
      proposedId: `proposed_${scene.layoutClass}_${Date.now().toString(36)}`,
      layoutClass: scene.layoutClass,
      regions: scene.regions.map((r) => ({ ...r, rect: { ...r.rect } })),
      referenceHash: scene.referenceHash,
      window: { ...scene.window },
      createdAt: new Date().toISOString(),
    };
  }

  coverageReport(): CoverageStats {
    const perFamily: CoverageStats["perFamily"] = {};
    for (const f of this.loadFamilies()) {
      const exs = this.loadExemplars(f.id);
      if (exs.length) {
        perFamily[f.id] = {
          exemplars: exs.length,
          avgScore: Math.round((exs.reduce((s, e) => s + e.closedLoopScore, 0) / exs.length) * 10) / 10,
        };
      }
    }
    // Corpus-level match stats come from the last learn-corpus run (Task 4 writes them).
    let totalScenes = 0, known = 0, familyNew = 0, novel = 0;
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(this.rootDir, "corpus-report.json"), "utf8")) as
        { totals?: { scenes: number; known: number; family_new: number; novel: number } };
      totalScenes = rep.totals?.scenes ?? 0;
      known = rep.totals?.known ?? 0;
      familyNew = rep.totals?.family_new ?? 0;
      novel = rep.totals?.novel ?? 0;
    } catch { /* no corpus run yet */ }
    return {
      totalScenes, known, familyNew, novel,
      coveragePct: totalScenes ? Math.round((known / totalScenes) * 1000) / 10 : 0,
      perFamily,
    };
  }
}
