# B-roll Factory — self-correcting, context-aware B-roll subsystem

A closed-loop pipeline that plans, writes, generates, criticizes, and places B-roll
so the final edit is physically correct, on-context, varied, and well-targeted.
Born from real defects: off-topic clips forced in for "variety", a Kling clip whose
laptop had no screen, and all-generated clips being the same "person at a laptop" shot.

## The pipeline (layers + gates)

```
Layer 0  CREATIVE DIRECTOR  (context-aware shot list)            [Phase 2 — TODO]
  Understands the video's full context (e.g. "AI course" → students, learning, AI
  tools, AI/tech ABSTRACT visuals, earning, success, locale). Emits a DIVERSE shot
  list by TYPE: real-footage · person-using-AI · AI/tech-abstract · screen-content ·
  environment — so nothing repeats in type OR content. Sets duration + recurrence cap.
        ↓ per beat: {intent, shot-type, duration, max-recurrence}
Layer 1  PROMPT WRITER → PROMPT CRITIC   (pre-gen, ≤2 iters)     [Phase 1 — DONE]
  prompt-engineer drafts the Kling 3.0 prompt → broll-prompt-critic (Opus) scores it
  for physical plausibility (flipped/absent screens, hands, garbled text, geometry),
  renderability, intent coverage, variety, authenticity → returns a REVISED prompt +
  negative prompt. Loop until APPROVE or 2 rounds. NO credits spent here.
        ↓ approved prompt
Layer 2  GENERATE (Kling 3.0 Turbo, 9:16/1080p/3–5s)            [DONE]
  Higgsfield kling3_0_turbo. 8 credits/clip. Decline auto-preset (declined_preset_id)
  to render literally. NEVER spend without explicit user go-ahead.
        ↓ raw clip
Layer 3  VIDEO CRITIC   (post-gen, WATCH-before-use, ≤2 regen)   [Phase 1 — DONE]
  broll-video-critic (Opus) extracts frames across the clip, reads them full-res,
  compares consecutive frames for morphing. Checks physical correctness, intent match,
  quality, motion, crop-readiness (subject in central vertical third), duration.
  Verdict ACCEPT / REGENERATE(+feedback→Layer 1) / REJECT. Bounded iterations.
        ↓ approved clips only
Layer 4  PLACEMENT & CROP engine                                 [Phase 3 — TODO]
  Sticky semantic placement (a clip locks to its best beat; variety fills the rest) ·
  no-repeat window + per-clip screen-time cap (kills over-repetition) · face-aware
  band crop · per-critic duration. Relevance-constrained variety already excludes
  off-topic sources (enforceBrollVariety on usable sources only).
```

## Agents (durable, Opus)
- `.claude/agents/broll-prompt-critic.md` — adversarial PROMPT critic (pre-gen).
- `.claude/agents/broll-video-critic.md` — adversarial VIDEO critic (watches clips).
Invoke via Agent tool; this session they ran via `general-purpose` + `model: opus`
loading their `.md` as instructions (project agents may not auto-register mid-session).

## Proven (Phase 1, 2026-06-29)
gen2-earning v1 → video-critic caught "laptop has no screen / reversed base / drifts
out of frame"; prompt-critic independently found the root cause (two devices, no
spatial anchor) and rewrote it (single device, explicit hinge geometry, earnings glow
on-screen) → regenerated → video-critic re-watched → ACCEPT. One iteration.

## Additions beyond the original ask
sticky placement · no-repeat window + screen-time budget · shot-TYPE diversity quota ·
shared physical-plausibility checklist · generated-clip LIBRARY (tagged, reusable) ·
cost guardrails (bounded iters, preflight get_cost, explicit go-ahead).

## Cost guardrails
Kling Turbo = 8 credits/clip. Preflight with `get_cost:true`. Bounded regen (≤2).
Explicit user go-ahead before ANY spend (enforced by the auto-mode classifier too).

See [[styleclone-editing-spec]] · component methodology in `docs/` · the prompt
cheat-sheet in `docs/broll-prompts-kling.md`.
