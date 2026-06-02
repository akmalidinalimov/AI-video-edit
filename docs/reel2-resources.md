# Reel 2 — Resource Bill of Materials (to recreate IMG_6298 at ≥98%)

**Reference:** `public/uploads/references/IMG_6298.MP4` · 720×1280, 56.8s, 30fps, English.
**Topic:** a tutorial showing how to use AI (Seedance 2.0) to create **lip-synced animated
characters with consistent voices** from real recorded audio.
**Structure:** a **demo half** (0–24s, a 50/50 split-screen: real voice actors on top, the
AI-animated characters lip-syncing on the bottom) → a **tutorial half** (24–57s, presenter in a
PiP while dark-mode node-graph motion graphics explain the workflow) → **CTA** ("Comment AI").

Source-code of truth: `public/exports/reel2/resource-manifest.json` + `style-profile.json`.

---

## 🟦 YOU UPLOAD (real footage / brand assets) — `user_upload`
| # | Element | What it is | How many |
|---|---|---|---|
| 1 | **Presenter A-roll — voice actor(s)** | Real talking-head footage of the person(s) performing the lines into a mic, studio look. The demo half shows a man + a woman alternating. | 1–2 people |
| 2 | **Presenter A-roll — tutorial host** | Real talking-head of the host explaining the steps (used as a small PiP in the tutorial half). Can be the same person as above. | 1 |
| 3 | **Logo** | The small brand logo shown top-right throughout. | 1 |

> If you don't have actors, we *can* AI-generate a talking presenter too — but real footage reads
> best for the "Real Video" half (that contrast is the whole hook). Your call.

## 🟩 WE GENERATE WITH AI (no upload) — `ai_generate`
| # | Element | What it is | How many |
|---|---|---|---|
| 4 | **AI character animation B-roll** | The Pixar-style animated characters (+ a bear) lip-synced to the audio — the core "wow" of the reel. We generate these with our B-roll system (image→video, identity-held characters, lip-sync). | ~8 short clips |

> To match the reel's *premise* (lip-sync from YOUR audio), we'd drive these from the uploaded
> A-roll audio. If you have specific character looks in mind, you can optionally upload reference
> images; otherwise we design them.

## 🟪 WE BUILD IN REMOTION (motion graphics, no upload) — `remotion_build`
| # | Element | What it is | How many |
|---|---|---|---|
| 5 | **UI / node-graph motion graphics** | The dark-mode animated workflow (timeline track removal, image-generator → video-generator nodes, "Seedance 2.0", typed prompt). Built as motion graphics. | ~3 sequences |
| 6 | **Text labels & title cards** | The white pill labels ("Real Video", "Lip Sync Seedance 2.0"), the "Magnific / Consistent Voice" title card. | ~2 styles |
| 7 | **CTA overlay** | The final animated **"Comment 'AI'"** card (display font, pop-in). | 1 |
| — | Split-screen layout, logo placement, transitions (hard cuts) | The 50/50 split, cuts timed to dialogue | layout |

## 🟧 WE GENERATE THE SOUND (audio APIs) — `audio_gen`
| # | Element | What it is | How many |
|---|---|---|---|
| 8 | **Background music** | Subtle ambient electronic / tech music bed (tutorial half). | 1 |
| 9 | **Bear roar SFX** | Deep bear growl/roar (demo half, ~6.5s). | 1 |
| 10 | **UI click / pop SFX** | Short clicks/pops synced to on-screen actions in the tutorial. | several |

> The presenter/character **voices** come WITH your uploaded A-roll audio (that's the source the
> lip-sync is built from) — we don't generate those.

---

## Summary — what we need from you to start
1. **Upload** the presenter/voice-actor A-roll clip(s) (with clean audio) + your logo → drop them in
   `public/uploads/arolls/` (or tell me where).
2. **Approve** AI-generation of the animated characters (and whether to provide reference images).
3. Everything else (motion graphics, captions/labels, CTA, music, SFX, split-screen layout) — **we
   build/generate**; no upload needed.

Once your uploads + approvals are in, we move to **Phase C: replicate in Remotion** (the layered
compositor) and verify against IMG_6298. Nothing here touches reel 1.
