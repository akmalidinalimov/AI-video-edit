# Next-Session Handoff — Style-Clone Engine (Remotion-authoring focus)

**Read this with [`engine-roadmap.md`](engine-roadmap.md) (canonical strategy). This doc is the
step-by-step execution handoff + the Remotion-authoring pivot.** A cold session should read, in order:
`engine-roadmap.md` → this file → `aroll-pipeline.md` (the A-ROLL DEFINITION OF DONE) →
`cropping-rules.md` → `style-cloning-principles.md` → `.knowledge/lessons/multi-aroll-qa.md`.
Session memory auto-loads and points here.

---

## 1. What was done (2026-06-03/04, branch `reel2-aroll-v3`)

- **Stage-1 item-1 DONE — orchestrator proven end-to-end.** `style-director.workflow.mjs` ran the full
  decode→plan→build→render→verify→iterate loop on reel2 vs IMG_6298 (4 iters): style-fidelity **65→76**.
  Commits `db5f996`, `0066c43` (+ roadmap `c265243`).
- **Audio-continuity gate created + wired.** `scripts/reel2-audio-check.mjs` (per-segment `volumedetect`).
  Found because the loop SILENCED turn t3 while the visual score rose. Root cause: `cutTop`'s letterbox
  branch used `-filter_complex` with no `-map 0:a` → audio dropped on the only close-subject turn. Fixed.
- **t3 "cropped/zoomed" fix.** Replaced the fixed `FACE_FRAC_TARGET=0.52` zoom-out with a **motion-envelope**
  band crop (`detectFace` returns per-frame crown/chin extremes; `calculateBandCrop` sizes to the minimal
  head-safe window — full-bleed preferred, thin letterbox only when a lean-in needs it).
- **New tooling/guardrails:** `--recut-top <t>` surgical single-turn re-cut; no-clobber-source rule;
  lessons encoded as **18 regression guards** + KB updates (DoD, cropping-rules, principles §14/§15, lessons §17/§18).
- **Honest engine maturity** (see `engine-roadmap.md` for the table): style-fidelity ✅ proven; orchestrator
  ✅ proven end-to-end; decode ⚠️ shallow (no CV measurement); motion-library 🟡 not render-tested;
  broll-engine 🟡 dry-only; **Remotion BUILD step = ad-hoc, no craft layer** (the focus below).

---

## 2. The pivot — Remotion authoring is the ENGINE (a "translator" between reference and code)

The bottleneck is not decode or scoring — it is the **BUILD/translate** step: turning a decoded reference
style into Remotion code that produces *outstanding* motion graphics. Today the orchestrator's
Remotion-Engineer just edits the composition ad-hoc with no shared craft vocabulary. We need a **translator
(middleman)** that knows how to instruct Remotion well.

**Proposed architecture (build this):**
```
reference recipe  ──►  STYLE/MOTION SPEC  ──►  [ REMOTION-AUTHORING SKILL ]  ──►  remotion-author agent  ──►  composition.tsx  ──►  GATES
(decode, Stage 2)      (measured fields)        craft vocabulary + patterns       composes + patches            (Remotion)         (closed loop)
                                                 = docs/motion-library + NEW
                                                   docs/remotion-authoring.md
```
- **Knowledge (committed, durable):** enrich `docs/motion-library/` (real param ranges per pattern) and add
  a new **`docs/remotion-authoring.md`** — the craft playbook: how to express camera moves, element motion,
  kinetic type, transitions, easing, timing, layered graphic design AS Remotion (`interpolate`, `spring`,
  `Sequence`, `useCurrentFrame`, `OffthreadVideo`, masks, `@remotion/*` helpers). Pair with the verified
  `remotion-best-practices` skill (already installed).
- **The skill (local wrapper):** a `remotion-authoring` SKILL.md that loads the above and turns a motion
  recipe → concrete, parameterized Remotion code. (Skills under `.claude/skills/` are LOCAL/gitignored —
  the durable knowledge MUST live in the committed docs; the skill is just the loader.)
- **The agent:** a `remotion-author` subagent (the translator) the orchestrator's BUILD leg calls instead of
  the generic Remotion-Engineer. Inputs: shot spec + motion recipe + the authoring playbook. Output: a
  composition patch that typechecks + renders. Spec it before building; verify with the gates below.
- **Corpus to enrich it (the "~20 videos" idea — Stage 3):** decode 15–20 exemplar reels → mine real motion
  & graphic-design patterns → expand the motion-library + remotion-authoring playbook with measured,
  render-tested patterns. Do this AFTER the authoring skill/agent exists, so mined patterns have a home.

---

## 3. Step-by-step next steps — each GATED by a closed loop

> For EVERY step: (a) name the agents + skills it needs; (b) if a capability is missing, find it with the
> **`find-skills`** skill and VET before install (see §4); (c) run independent sub-tasks in PARALLEL with
> worktree isolation (§5); (d) verify with the step's closed loop; (e) never present output that hasn't
> passed every gate (§6).

**Step A — Stand up the Remotion-authoring layer (the translator).** Highest leverage.
- Skills: `remotion-best-practices` (installed), new `remotion-authoring` (build), `motion-designer`.
- Write `docs/remotion-authoring.md` + enrich `docs/motion-library/` (params). Build the `remotion-author`
  agent spec. Render-test on a throwaway `MotionLibraryProbe` composition.
- Closed loop: each pattern renders; `reel2-cut-check`; visual eyeball of the probe.

**Step B — Render-test the 16 motion patterns (Stage-1 item-2).**
- Add `MotionLibraryProbe` comp + `scripts/motion-library-check.mjs`. Add as a regression check.
- Gate: every pattern renders with no error/black frame; output watched.

**Step C — Color-grade capability (the 76→85 blocker).** The fidelity punch-list's top items route to
`color`, which has NO implementer. Add a real grade step (per-band LUT/curve in the composition) + a
`color` role the orchestrator can call. Re-run the orchestrator; expect >76.
- Gate: style-fidelity up on the colorGrade dimension; audio/crop/cut still green.

**Step D — Exercise B-roll for real (Stage-1 item-3).** Set `PEXELS_API_KEY`; fetch 1 stock clip; run 1
Kling 3.0 generation through the cleanliness/anatomy gates. Keep cost minimal.

**Step E — Deepen decode (Stage 2).** Wire the existing CV infra (`analyze_edit.py`, coordinate/pip/
reference measurers, font-classifier, beatDetector) + RAFT/CoTracker3 into decode so the Analyst gets
MEASURED camera/element/layout/font/beat fields, not Gemini prose. Add `decode-fidelity.mjs` gate.

**Step F — Corpus / learn from ~20 videos (Stage 3).** Curate 15–20 exemplar reels (we already have
`IMG_6295/6296/6299/6326–6331` in `public/uploads/references/`; note license for any new ones). Decode each
→ mine patterns → enrich `docs/motion-library/` + `docs/remotion-authoring.md` (real param ranges +
exemplar ref per pattern). Biggest parallel win — fan out the decode.

**Also open:** the CTA-tail audio (27.2–33.5s silent in reel2 — deferred music bed → wants a voice/audio role).

---

## 4. Identify + acquire the skills/agents each step needs

- **First, take inventory:** which agents/skills already exist (engine skills are under `.claude/skills/`;
  `remotion-best-practices` installed & vetted). Decide what's missing per step (§3).
- **Find missing skills with the `find-skills` skill** (`/find-skills` or the Skill tool). Prefer official
  / high-install / audited sources.
- **VET before installing ANYTHING** (non-negotiable, per `engine-roadmap.md` guardrails):
  1. skills.sh 3 structural checks. 2. `~/.agents/tools/vet-skill.sh` (OSV dependency scan).
  Only install if clean. Use `/browse` for any web, never the Chrome MCP.
- Build project-specific agents (e.g. `remotion-author`, `color`, `voice/audio`) as specs first, then
  implement + verify.

---

## 5. Run agents in PARALLEL (worktrees + viewers)

- **Read/analyze fan-out** (corpus decode, pattern render-tests, fidelity scoring): a **Workflow** with
  `parallel()`/`pipeline()` — watch live in the **`/workflows`** viewer. No isolation needed.
- **Code-mutating fan-out** (each agent edits files): **git-worktree isolation** so they don't collide —
  `agent(prompt, { isolation: 'worktree' })` inside a Workflow, OR the **Agent tool** with
  `isolation:"worktree"` + `run_in_background:true` (watch in the agent/Fleet viewer). Worktrees auto-create
  + auto-clean. Merge/PR clean branches back to `reel2-aroll-v3`.
- Cap ~10 concurrent (12-core machine). Use `TeamCreate` only for interdependent work needing a shared board.
- Machine reality: a full reel render ≈ 5 min; Gemini decode/fidelity cost quota — batch wisely.

---

## 6. Verification — the closed loop is mandatory, EVERY step

Never present a render that hasn't passed every gate on the RENDERED output (the A-ROLL DEFINITION OF DONE,
`aroll-pipeline.md`). The Remotion-path gates:
- Words complete + in order, no overlap → `scripts/reel2-transcribe.mjs`
- Head-safe crop on the WORST frame (lean-in), not the median → `scripts/reel2-crop-check.mjs`
- No black-flash at cuts → `scripts/reel2-cut-check.mjs`
- **Audio continuity — no SILENT talking segment** → `scripts/reel2-audio-check.mjs`
- Style match + punch-list → `scripts/style-fidelity.mjs`
- **The frame/style score is BLIND to audio + per-frame motion.** A rising score ≠ done. ALWAYS, as the
  final step, **WATCH the video and LISTEN to it** (sample frames across the timeline + check audio levels/
  silence). The 2026-06-03 incident (silent + zoom-cropped turn shipped at "76/100") is why this is a hard rule.
- Before any commit to pipeline code: `node scripts/test-regression.mjs` (must be all-green; add a new check
  for every bug fixed).

---

## 7. Decisions for the user (surface before the big spend)

1. **Corpus**: which ~20 reels, and their licenses? (Stage 3 sourcing.)
2. **Target style ceiling**: keep 85 fidelity target, or push Act-2 specifically?
3. **Audio/voice role**: add SFX/music-bed authoring now (CTA tail), or defer?
4. **Remotion-author agent scope**: how creative/autonomous vs. tightly recipe-driven?
