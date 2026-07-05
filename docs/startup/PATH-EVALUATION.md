# PATH-EVALUATION — Are We Building the Right Things in the Right Order?

**Date:** 2026-07-02 · Final synthesis of the overnight strategy program.
**Inputs:** VALIDATION-REPORT.md (GO-conditional), REFERENCE-TAXONOMY.md (72 types),
TOOLS.md, PLATFORM-SPEC.md + BUILD-PLAYBOOK.md (7 milestones), UNIVERSAL-1-MILESTONE.md
(engine state as of tonight).
**Question asked:** are we starting the right things, working on the right things —
reference decoding, component decomposition, the self-learning knowledge base?

---

## 1. Verdict on the path so far

**Overall: the path is right. The order is right. The pace on generalization was the
one real mistake.** Detail per bet, honestly:

### (a) Reference-decode-FIRST, before UI/platform — RIGHT, and it's now provably right

This was the highest-risk sequencing decision and it paid off. The validation report's
entire wedge sentence — *"point at any reel, get your footage in that style, with a
measured accuracy score"* — is only sayable because the decode engine exists and is
measured. If we had built the platform first, we'd today have a nice upload page in
front of an engine that couldn't back the pitch, in a market where Sparki already
*markets* the claim without proof. The decode engine + metric is simultaneously the
product, the moat-seed, and the pitch (VALIDATION-REPORT §7). A UI is 4–6 weeks of
known work (BUILD-PLAYBOOK M4–M7); the decode engine was months of unknown work.
Doing the unknown first was correct. **No change.**

### (b) Deterministic-CV-over-VLM + the falsifiable closed-loop metric — RIGHT, our best decision

The closed-loop metric (decode(reference) vs decode(output)) is the single most
valuable artifact in the repo, because it repeatedly *caught things we were wrong
about*:

- It **caught the wrong-direction pacing fix** — a change that looked right to the eye
  moved the score the wrong way, and was reverted on evidence, not opinion.
- The 73.4% → 98.1% climb on R1 was only possible because every iteration had a number.
- The spike discipline is the same instinct applied to architecture: the Remotion
  N-region compositing plan was **falsified before building it** (10.25x realtime vs a
  <4x bar — UNIVERSAL-1 Wave-2 note), saving weeks and forcing the correct FFmpeg
  filtergraph + alphamerge design.

The deterministic-CV discipline (measure with pixels, use the VLM for semantics only)
is why the metric is trustworthy at all — a VLM scoring a VLM would be circular.

**One honest caveat the validation report names and we must accept:** 98.1% is a
*founder-reported internal metric*. It is falsifiable but not yet independently
auditable. That's not a flaw in the bet — it's the next step of the same bet (see §2).

### (c) Component decomposition (A-roll / B-roll / captions / motion as separate engines) — RIGHT

This is what makes the closed-loop score *diagnostic* instead of just a grade: when the
score drops, the per-dimension DecodedField comparison says *which component* drifted.
It's also what the CapCut-templates objection rests on (VALIDATION-REPORT §4): templates
slot-fill; we re-time captions to the user's speech, place B-roll on narrative beats,
and adapt layout to their footage — only possible because each component is its own
engine with its own gates. And it maps 1:1 onto the taxonomy's structure (primary
layout entry + modifier axes). The per-component watch-before-ship gates (editing-spec
methodology) are the reason quality compounds instead of regressing. **No change.**

### (d) Self-learning archetype KB, built early — RIGHT to build, EARLY was slightly premature but cheap

The honest read: with 3 references, the KB is scaffolding, not yet a flywheel. But it
already earned its keep once — **the gate caught archetype poisoning** (a bad exemplar
that would have silently corrupted future decodes was rejected by the consistency
gate). That single catch justifies the gated-write design. And the taxonomy work showed
the KB is the *only* plausible path from 3 styles to 72 types: each new reference is a
calibrated recipe, not new code. The mistake would have been building the KB *instead
of* the second style class; we didn't — decode generalization proceeded in parallel.
Verdict: keep, but the KB earns real returns only after the 50–100 role-video ingestion
(REFERENCE-TAXONOMY Part 3), which is correctly sequenced post-demo.

### (e) The audit → gate → fix working loop itself — RIGHT, keep it as house law

Tonight's UNIVERSAL-1 progress (unified decode passing gates on R1/R2/R3) came from
exactly this loop: parallel audit → gap map → adversarial gate → prioritized fixes.
The regression suite's "every bug adds a check" rule means the same bug never ships
twice. The BUILD-PLAYBOOK's testing pyramid just codifies what the loop already proved.

### Where we were WRONG or slow — say it plainly

1. **The 2-region assumption was baked deep, and we didn't notice until reality did.**
   The seam detector, plan builder, and renderer all silently assumed top/bottom split.
   It surfaced only when the user uploaded R2 — not from any internal review. Lesson:
   *the user's next upload is the best adversarial test we have; solicit weird
   references early and often.* The taxonomy's 30 stress tests exist precisely so this
   never happens by surprise again.
2. **Single-reference overfitting was a live risk for weeks.** 98.1% on R1 while R2/R3
   couldn't render meant the headline number described a demo, not an engine. The
   validation report is blunt: "a one-style demo is a feature, not a company." We're
   fixing this now (UNIVERSAL-1), but we should have set the 3-reference bar a month
   earlier.
3. **VLM-semantics sat dormant for days** while deterministic-CV work proceeded —
   partially justified (CV was the bottleneck), but it delayed the unified decode path
   and left two disconnected pipelines longer than necessary.
4. **License diligence was reactive** — MMS's CC-BY-NC was discovered after
   verification effort was spent. TOOLS.md now front-loads license checks; keep that.

---

## 2. Does the validation change engineering priorities? Yes — four promotions, three demotions.

### PROMOTED

1. **Independently auditable accuracy benchmark** (from "internal metric" → product
   surface). The report says the 98% figure is the moat *and* the marketing asset, but
   only if a third party can reproduce it. Concretely: publish the scoring code path,
   fixed fixtures, and a side-by-side video per reference; plan a public benchmark page.
   This is cheap — the harness already exists (`compare-style.ts`, L5 gate); it needs
   packaging, not invention.
2. **Sparki hands-on teardown — this week, non-negotiable.** The report's explicit
   action item: buy Sparki, run the same reference through both engines, publish the
   side-by-side. Outcome either strengthens the GO (their Copy Style is superficial) or
   tells us exactly what to beat. Also calibrates messaging vs Gemini Omni ("your real
   footage, real edit, measured fidelity" — not pixel regeneration).
3. **Preset library = saved decodes — promoted to launch scope.** The report's verdict
   on the founder's idea: YES at launch. Engineering cost ≈ zero (a preset is a cached
   Reference Decode + render recipe — the KB already stores exactly this). It solves
   cold-start, demos instantly, and answers "CapCut has templates."
4. **The decode-preview trust moment as THE demo wow.** The report's review-mining shows
   the category's #1 complaint is "AI doesn't get the style I want." The moment
   StyleClone shows *"here is what I measured in your reference — seam at 0.58, 1:1
   B-roll top, captions word-by-word, cut every 2.1s"* before rendering anything is the
   moment no competitor can fake. PLATFORM-SPEC already sketches this screen; pull it
   forward into the demo narrative (even as a static mock over real decode JSON).

### DEMOTED / PARKED

- **Audio/SFX/music style cloning** — already a UNIVERSAL-1 non-goal; validation adds
  no reason to revisit. Post-demo, behind licensed sources only (TOOLS #9).
- **API for other tools** — LATER per the report (pre-PMF it fragments focus and gives
  competitors a scouting window). Park until 4–5 style classes.
- **Style marketplace** — phase 2, revisit at ~1,000 active users. The moat-maker
  eventually; a distraction now.

### Is the 3-reference scope the right demo bar vs the taxonomy's 72 types?

**Yes — 3 now, with a public benchmark plan as the bridge.** The three references span
three distinct layout *families* (split / multi-region stack / PIP), which is what
"generalizes" means to an investor — while 72 types is what "we know the whole space"
means. The NO-GO trigger is "can't generalize past one style class within ~6 weeks";
UNIVERSAL-1 answers exactly that. Don't expand demo scope. Instead: demo 3 styles +
show the taxonomy as the roadmap slide + commit to a public benchmark page that adds
types over time (each new type = a preset = a marketing beat). That turns the gap
between 3 and 72 from a weakness into a visible march.

---

## 3. Top-10 concrete improvements (impact ÷ effort, ranked)

| # | What | Why (evidence) | When |
|---|------|----------------|------|
| 1 | **Finish the N-region renderer (R2 end-to-end)** | The NO-GO condition is failure to generalize; R2 render is the proof. Architecture already spike-verified (FFmpeg filtergraph + sharp alphamerge). BUILD-PLAYBOOK M1 tasks 1.1–1.8 | This week |
| 2 | **Sparki teardown + side-by-side publish** | VALIDATION §7: closest competitor, unverified claim; result changes messaging either way | This week |
| 3 | **Run validation experiments A & B (Telegram pre-sell + founding-member pre-order)** | The GO is *conditional on this*; bars: ≥5/10 paid concierge slots, ≥5/20 pre-pay. Costs ~$0 with the 500-student audience | This week (parallel with #1) |
| 4 | **Make the accuracy metric independently auditable** — fixed fixtures, published scoring path, side-by-side videos per reference | VALIDATION confidence-gaps: "make it auditable before pitching investors" | Before demo |
| 5 | **R3 time dimension + exact PIP geometry** | Third style family = the generalization story complete; contentTimeline schema already exists (TAXONOMY status table) | Before demo |
| 6 | **Decode-preview screen (even static-mock over real JSON)** | The trust moment no competitor has; counters the category's top complaint | Demo |
| 7 | **TransNetV2 shot detection swap** | TOOLS #2: PySceneDetect F1 <0.6 on exactly our fast-cut regime; TransNetV2 ~0.75–0.82, MIT, free, one-file inference — cheapest big decode-accuracy win | Before demo |
| 8 | **License hygiene sweep: Remotion company license + confirm MMS is out of the live path** | TOOLS #7 (paid license required) + the CC-BY-NC burn; UNIVERSAL-1 reliability gate requires no NC deps | This week (hours, not days) |
| 9 | **Preset library v0: package R1/R2/R3 decodes as 3 named presets** | VALIDATION §5: yes-at-launch; near-zero engine cost; each future style = preset + benchmark entry + marketing beat | Demo (as the "presets" slide/flow) |
| 10 | **Gemini 3 Pro swap for the semantic decode tier** | TOOLS #1: UPGRADE NOW verdict; attacks the semantic-tier ceiling; keep deterministic CV as the measured tier | Post-demo (don't destabilize decode mid-UNIVERSAL-1) |

Floated-ideas verdicts, consolidated (from VALIDATION §5): **presets — yes at launch**
(#9). **Marketplace — phase 2**, ~1,000 users. **Agency/team tier — strong revenue path,
build after creator PMF** (pivot target if experiments A/B miss). **API — later**, after
4–5 style classes.

---

## 4. If we only do 5 things before the demo

1. **R2 renders end-to-end** through the real route, closed loop ≥90%, watch-test
   signed. (The generalization proof — kills the NO-GO condition.)
2. **Run the pre-sell** (experiments A + B in the Telegram audience). The engine work
   is worthless if nobody pays $12; this is the other half of the GO-conditional.
3. **Sparki side-by-side.** Know the closest competitor cold before anyone asks.
4. **Auditable benchmark package**: fixtures + scoring script + 3 side-by-side videos.
   Turns "founder says 98%" into "run it yourself."
5. **The decode-preview moment in the demo**: show the measured decode *before* the
   render, then the side-by-side, then the score. That 60-second sequence — *see it,
   measure it, reproduce it, prove it* — is the company in miniature.

Everything else — R3 polish, TransNetV2, presets packaging — makes the demo better.
These five make the demo *true*.

---

**Bottom line for the morning read:** You bet on decode-first, measurement-first, and
components-first, and every one of those bets has now either caught a real error or
killed a bad plan before it cost you — that's what a right path looks like. The one
genuine miss was letting a single reference define "working" for too long; UNIVERSAL-1
is the correction, and it's already mid-flight. The validation doesn't redirect the
engineering — it *confirms* it, and adds exactly three non-engineering obligations:
make the number auditable, tear down Sparki, and ask your own audience for money this
week.
