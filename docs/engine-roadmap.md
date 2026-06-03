# Style-Clone Engine — Roadmap & Handoff (canonical, in-repo)

The replication engine = "understand a reference video → replicate its editing/motion style with the user's
own A-roll/B-roll." This doc is the durable handoff so any session can resume cold. (The fuller working plan
is also at `~/.claude/plans/continue-reel-2-v3-delegated-parasol.md`, but THIS committed doc is canonical.)

> **Resuming? Read [`NEXT-SESSION-HANDOFF.md`](NEXT-SESSION-HANDOFF.md)** — the step-by-step execution plan
> + the Remotion-authoring pivot (the BUILD/translate step is the real engine; build a `remotion-author`
> translator skill+agent, enrich it from a ~20-reel corpus). It names the agents/skills per step, the
> find-skills+vet flow, parallel-worktree execution, and the closed-loop + watch/listen verification.

## Current maturity (honest, as of commit `88422bf`, branch `reel2-aroll-v3`)
- ✅ **style-fidelity** (`scripts/style-fidelity.mjs`) — PROVEN. Scores output vs reference on 6 style dims +
  routable punch-list. Baseline on reel2 vs IMG_6298 = **65/100** (Act-1 78-84 match; Act-2 44-59 gap; lowest
  motionLanguage 57, composition 57). Report at `public/exports/reel2/style-fidelity-report.json`.
- ⚠️ **reference-decoder** (`scripts/reference-decode.mjs`) — SHALLOW. Gemini prose + ffmpeg frames only;
  does NOT use existing measurement infra (`scripts/python/analyze_edit.py`; `src/lib/analysis/{coordinate-
  measurer,pip-locator,reference-measurer,font-classifier,beatDetector,frameExtractor}.ts`). **Core gap.**
- 🟡 **motion-library** (`docs/motion-library/`, 16 patterns + skill `motion-designer`) — documented, NOT
  render-tested standalone.
- 🟡 **broll-engine** (`scripts/broll-engine.mjs`) — cost-aware router proven via `--dry-run`; real stock
  fetch + generation never exercised. Routing: stock → Kling 3.0 @1080p default → Seedance 2.0 @720p gated.
- ✅ **style-director orchestrator** (`scripts/workflows/style-director.workflow.mjs` + skill) — PROVEN
  end-to-end (Stage-1 item-1, 2026-06-03). One run: 4 iters, decode→plan→build→render→verify loop raised
  style-fidelity **65→76** on reel2 vs IMG_6298; cut-check + crop-check green. Target 85 NOT reached —
  plateaus at 76 because the top punch-list items route to **`color`**, which has **no implementing role**
  (the FIDELITY schema lists a `color` route but the iterate loop only feeds the Remotion-Engineer; there
  is no LUT/grade step in the composition). Other residual gaps: tighter crops, faster pacing (Act-2
  V1/A1 timeline + waveform + moving playhead ARE present in the final render — the Gemini scorer
  sampled frames that missed them, so Act-2 layout/motion is scored harsh).
  **AUDIO GAP (was critical — NOW FIXED):** the verify loop had NO audio gate, so it raised the visual
  score while SILENCING turn t3. Root cause: `cutTop` (reel2-build-act1.mjs) letterbox branch used
  `-filter_complex` with no `-map 0:a` → ffmpeg dropped audio; t3 is the only letterbox (close-subject)
  turn. Fixes shipped: `cutTop` now maps `[outv]`+`0:a?`; new `scripts/reel2-audio-check.mjs` per-segment
  gate wired into the verify loop as a HARD GATE; new `--recut-top <t>` surgical re-cut; no-clobber
  guardrail in the build brief. t3 re-cut + re-rendered: audio/crop/cut all PASS. STILL OPEN: the CTA
  end (27.2-33.5s) is silent in both renders (deferred music bed) → wants the voice/audio role.
  Findings: (a) `args.maxIters:2` did NOT take — ran the default 4 (verify args plumbing before relying
  on it for cost caps); (b) subagents littered shell-junk files on Windows (bad redirection) — clean up,
  never `git add .`. Build edits left UNCOMMITTED in `src/remotion/{Root,compositions/Reel2Video,
  compositions/Act2NodeEditor}.tsx` + `docs/motion-library/elements.md` (net +11, keep).

## Decisions (locked)
1. Sequence = **solidify-then-elevate**. 2. Decode = **full measurement fusion** (wire existing libs + RAFT
optical-flow + CoTracker3 tracking + decode-fidelity gate). 3. KB = **curated exemplar corpus** (decode 10-20
exemplar reels into the motion + editing knowledge bases). Target = **95% STYLE-fidelity** (not pixels);
track Act-2 specifically. No own-model training (prompt-optimization instead). Render engine = Remotion.

## The plan — 3 stages, each with a HARD exit gate
### STAGE 1 — SOLIDIFY (prove what exists) [do first]
1. Run the **orchestrator end-to-end** on reel2/IMG_6298 Act-2 (via the `style-director` skill /
   `Workflow({scriptPath:"scripts/workflows/style-director.workflow.mjs", args:{reference:"public/uploads/references/IMG_6298.MP4", refId:"img6298", compositionId:"Reel2Video", target:85, maxIters:4}})`).
   Debug prompts, harden errors, prove the loop improves 65→higher. (Spends render time + maybe gen credits.)
2. **Render-test** the 16 motion patterns: new `MotionLibraryProbe` comp + `scripts/motion-library-check.mjs`.
3. **Exercise B-roll for real:** set `PEXELS_API_KEY`; fetch 1 stock clip; 1 Kling 3.0 gen through the gates.
4. Add the above as checks to `scripts/test-regression.mjs`.
EXIT: orchestrator ran + improved score; all patterns render; broll yields a real gated clip; regression green.

### STAGE 2 — ELEVATE COMPREHENSION (full measurement fusion)
1. Wire EXISTING infra into decode: `analyze_edit.py` cuts (+ **TransNetV2** for gradual), coordinate/pip/
   reference measurers, `font-classifier`, `beatDetector`; fuse with Gemini + multimodal frames.
2. Add MEASURED motion: `scripts/python/measure_motion.py` (**RAFT** camera vector + **CoTracker3** tracks);
   one-time venv + ~GB model downloads (like MMS) — document.
3. `scripts/decode-fidelity.mjs` gate — recipe must match frames (no hallucination).
4. Extend recipe / `src/lib/types/styleProfileV2.ts` with measured fields; orchestrator Analyst consumes them.
EXIT: every shot has measured camera/element/layout/font/beat fields; decode-fidelity ≥ threshold; score > S1.

### STAGE 3 — DEEPEN KNOWLEDGE BASES (curated corpus)
1. Curate 10-20 exemplar reels → `public/uploads/references/corpus/` (user-provided/royalty-free; note license).
2. Decode each → mine patterns → expand `docs/motion-library/` (real param ranges + exemplar ref per pattern).
3. Consolidate a deep editing-craft KB (`docs/editing-craft.md` + `style-cloning-principles.md` + `aroll-
   pipeline.md`) + new `editor` skill the Editor role loads.
EXIT: ≥N reels decoded; libraries expanded + render-tested; final orchestrator run highest yet (≥85; Act-2 ≥80).

## PARALLEL multi-agent execution (run 6-7 at once) — this machine: 12 cores → cap 10 concurrent
- Read/analyze fan-out (corpus decode, pattern render-tests, fidelity scoring) → **Workflow `parallel()`**,
  live in the **`/workflows` viewer**. No isolation needed.
- Code-mutating fan-out → **git-worktree isolation**: `agent(prompt,{isolation:'worktree'})` in a Workflow, or
  the **Agent tool** with `isolation:"worktree"` + `run_in_background:true` (watch in the agent/Fleet viewer),
  or manual `git worktree add ../sc-wt-N -b wt/feat-N` → merge/PR back to `reel2-aroll-v3`. Tools auto-create +
  auto-clean worktrees (nothing to install). GitHub view = push `wt/*` branches + open PRs.
- `TeamCreate` for interdependent work (shared task board). Biggest parallel win = Stage 3 corpus decode.

## Guardrails (carry forward)
- Commits end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Never `git add .` (fragment-named shell-junk files litter the tree) — stage explicit paths only.
- `.claude/skills/*` is gitignored → SKILL.md wrappers are LOCAL; durable engine = committed scripts + docs.
- `public/` is gitignored (regenerable media). Surface full Windows output paths on render completion.
- Vet any new skill before install: skills.sh 3 checks + `~/.agents/tools/vet-skill.sh` (OSV). Use `/browse`,
  not chrome MCP, for web.
</content>
