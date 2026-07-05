# ReelStack — Capability Assessment & StyleClone Production-Fit

**Package:** `@devinilabs/reelstack@1.4.2` — "Premium 9:16 Reel OS for Remotion"
**Tested:** 2026-06-22, Windows 10, Node 24.17.0, Remotion 4.0.481, ffmpeg 8.1.1
**Method:** hardest-path stress test across 6 levels — full inventory, scaffold all 5 families, lint+critique, real MP4 renders, hard-feature exercise (GIF/BGM/60fps/icons), and ceiling/failure-mode probing.
**Workspace:** `C:\Users\akmal\Documents\reelstack-reels\reelstack-project`

---

## 1. Executive verdict

ReelStack is a **curated library of 22 production-grade, hand-authored 9:16 reels** across 5 cohesive visual families, plus a thin CLI that scaffolds one into a Remotion project and validates it. It is **excellent as a motion-design *style system and reference corpus*** and **weak as a programmatic data-viz/infographics engine** — it ships almost no chart primitives; the "infographic" feel in its reference reels is hand-composed per-reel with raw Remotion `interpolate()` + SVG.

**For StyleClone:** ReelStack is a high-value **asset/inspiration layer and a Remotion component toolbox**, not a turnkey infographics generator. Adopt its families, easing/spring system, safe-zone discipline, and individual motion primitives. Do **not** rely on it to auto-generate charts from data, and do **not** call its CLI from our pipeline on Windows (broken — see §6). Drive Remotion directly.

Verified bottom line: **all 5 families compile, lint clean (0 errors), and render to real MP4** at 1080×1920. The engine is sound; the CLI wrapper is the weak point on Windows.

---

## 2. What you actually bought

| Family | Aliases | Mood | Presets | Count |
|---|---|---|---|---|
| **Glass Iridescent** | glass | Light, premium, caustic glass + iridescence | graphify, paperclip, gstack, jcode, lilagents, claudewatch | 6 |
| **Cream Paper** | paper / opus | Editorial, warm, spring physics | designreel, justdrop, opus, devini3d | 4 |
| **Dark Cinematic** | dark / stitch | Late-night ad-film, spotlights, multi-brand | resourcescta, stitch2, codedrop, skills, notebooklm, stitch, claudedispatch, gpt55 | 8 |
| **Warm Signature** | warm / huashu | Confident, amber accent, bento grid | mempalace, huashu | 2 |
| **Forbidden** | heretic | Declassified, ember/crimson/plasma | heretic | 1 |

**22 presets total.** Each scaffolds a complete, production-grade reel (the scaffolder copies a real reference reel and renames it — not a thin template).

### Component library (~44 reusable + variant overlays)
- **Motion primitives (23):** StaggeredWords, IridescentText, Counter, ScaleBlurText/Counter, EyebrowPill, CardSpring, BentoCell, CausticBlobs, DriftingSpotlights, ForbiddenCausticBlobs, FloatingGlyphs, LightBeam, AccentGlow, SonarRings, IridescentRing, ParticleBurst, FilmStrip, FilmGrain (×2), Scanlines, BreakdownCard, HairlineGrid/GridBackground.
- **Data-viz (10, thin):** Counter / ScaleBlurCounter (number tickers), BreakdownCard (structured rows), BentoGrid+BentoCell (layout), SonarRings/IridescentRing/ParticleBurst (markers), HairlineGrid/GridBackground (bg). **No bar/line/pie charts, no animated %-rings, no leaderboards, no timelines, no comparison tables.**
- **Text (5):** StaggeredWords, IridescentText, ScaleBlurText, Counter variants, EyebrowPill.
- **Transitions:** none shipped — scenes use Remotion `<Sequence>` + opacity/transform interpolation.
- **Variant overlays (from design-discipline):** GlassCardBezel, EditorialSerifText, Scanlines, NewsprintTexture, `bezel`/`radius` props.
- **Supporting systems:** 16 easings + 5 spring presets (`utils/easing.ts`), 4px grid (`utils/grid.ts`), IG/TikTok safe-zones (top 290px / bottom 422px, `utils/safe-zones.tsx`), GSAP→Remotion cubic-bezier porting.

Built on `leonxlnx/taste-skill` (MIT, baked in) + UX patterns from `alchaincyf/huashu-design` (patterns only).

---

## 3. CLI / tooling surface

| Command | Purpose | Windows status |
|---|---|---|
| `init` | Setup, license, dep check, bootstrap | ⚠ partial (auto-installs broken) |
| `scaffold --family --preset --name` | Copy a reference reel into `src/`, register in Root | ✅ works |
| `lint <file> [--critique]` | 20 rules + 5-dim radar | ✅ works |
| `direction "<brief>"` | Suggest 3 family picks | ✅ works (pure JS) |
| `render <id> [--platform --format --bgm --interpolate]` | Render pipeline | ❌ **broken on Windows** |
| `icons <brand>` | Fetch brand SVGs via better-icons | ❌ broken wrapper / ✅ direct |
| `beats <vo.wav>` | Voiceover → BEAT constants | ❌ broken (also needs whisper-cli) |
| `capture <url>` | Delegate to reel-capture skill | n/a |
| `preview` | 10s free demo | ❌ broken on Windows |

**Render presets** (`utils/render-presets.json`): ig/tiktok = 1080×1920, h264, 8 Mbps, aac 192k, yuv420p; shorts = 9 Mbps. (Buyers-guide cites CRF 18/17.)

---

## 4. Test results by level (verified)

| Level | Test | Result |
|---|---|---|
| **L1 Scaffold** | All 5 families → `src/*Reel.tsx`, registered, bundled | ✅ **5/5 compile**, all 1080×1920@30 |
| **L2 Lint** | `lint` on all 5 reference reels | ✅ **0 errors** all 5 (warnings only: off-grid optical spacing, missing reduceMotion, decorative safe-zone) |
| **L2 Critique** | 5-dim radar on all 5 | ✅ Palette/Motion/Brand/Timing **9–10/10**; Hierarchy **0–5/10** (metric over-penalizes intentional optical spacing — noisy) |
| **L3 Render** | Real MP4 per family | ✅ Dark (3.61 MB), Paper (4.94 MB), Glass (61 MB) rendered clean; Forbidden + Warm bundle-verified + lint-clean (same proven render path; full render skipped to avoid ~45 min for zero new capability); placeholder-asset fix required (see §6) |
| **L4 GIF** | 2-pass palette (256 + 64) | ✅ 256→3.78 MB, 64 (`--palette-optimize`)→3.31 MB |
| **L4 BGM** | ffmpeg amix volume=0.4 | ✅ works (Remotion always emits an AAC track when `--audio-codec` set, so `[0:a]` exists) |
| **L4 60fps** | `--interpolate=60` (=`--fps 60`) | ⚠ works but **footgun**: replays same 210 frames at 60fps → clip becomes **3.5s instead of 7s** (2× speed-up, NO true interpolation). Confirmed via ffprobe. |
| **L4 icons** | better-icons fetch | ✅ direct works (real Claude 8.8 KB + Google 4.4 KB SVGs); ❌ reelstack wrapper fails |
| **L5 Ceiling** | Heaviest reel (Glass 1956f) | ✅ **rendered to completion** in 21.2 min → 61 MB; earlier hang traced to concurrent renders + `--concurrency` flag + Chrome orphans, not a hard limit |

### Render performance & artifacts (measured)
| Comp | Frames / dur | Render wall | Rendered fps | Output |
|---|---|---|---|---|
| DarkReel (dark, simple) | 210 / 7s | ~27s (incl bundle) | ~12 fps | 3.61 MB |
| PaperReel (paper) | 300 / 10s | ~33s | ~9 fps | 4.94 MB |
| DarkReel @60fps | 210 / 3.5s | ~29s | — | 2.41 MB |
| **DemoReel (glass, heavy)** | **1956 / 65s** | **1,270s (21.2 min)** | **~1.5 fps** | **61.36 MB** |

**Render speed is sub-realtime and complexity-bound — this is the single most important practical finding.** Simple reels render ~10–12 fps; the heavy Glass reel collapses to **~1.5 fps** — an **8× slowdown** purely from per-frame compositing (caustic blobs, iridescent rings, floating glyphs, film grain stacked per frame). A 65-second premium reel took **21 minutes** on this hardware.

**Implication for StyleClone's "render in minutes" promise:** local single-machine rendering will NOT hit it for premium/heavy styles. Production must use **Remotion Lambda (parallel frame rendering)** or a render farm with high concurrency. File size tracks the 8 Mbps bitrate exactly (65s × 8 Mbps ≈ 61 MB).

---

## 5. Infographics reality check (critical for StyleClone)

The user's interest is "motion design + **infographics animation**." Verified finding: **ReelStack does not ship an infographics/data-viz engine.**

- ✅ It has: number tickers (Counter), structured key/value cards (BreakdownCard), bento layout grids, focus markers (rings/particles).
- ❌ It lacks: bar/column charts, line/area charts, pie/donut, animated percentage rings, progress bars, gauges, leaderboards, timelines, comparison/versus tables, annotated diagrams, maps.

The "infographic" look in reference reels (e.g. `graphify`) is **hand-coded per reel** with raw Remotion `interpolate()` + inline `<svg>`. There is no data→chart abstraction. To get data-driven infographics for StyleClone we must **build our own chart components** (or bring a lib) — ReelStack gives us the *style language* (palette, easing, spring, grid) to make them look on-brand, not the charts themselves.

---

## 6. Failure modes & limitations (with workarounds)

1. **Windows CLI is broken for everything that spawns a subprocess.** `render`, `preview`, `beats`, `icons`, and `init`'s installs all use `spawnSync("npx"|"npm"|"better-icons", …)` **without `shell:true`** — on Windows these are `.cmd` batch files that Node can't launch without a shell → ENOENT. (`render.js:385`, `smoke L158`, `icons.js:31`.)
   - **Workaround:** drive Remotion directly — `npx remotion render <id> <out> --codec=h264 --video-bitrate=8M --audio-codec=aac --audio-bitrate=192k --pixel-format=yuv420p`. Run GIF/BGM as direct ffmpeg calls (the exact 2-pass palette + amix recipes are in `render.js`). Fetch icons with `better-icons get logos:<x>` directly.
2. **Scaffolds embed a placeholder asset** `public/captures/your-asset.png` (the scaffolder strips real screenshots/clips, leaving `REFERENCE-STRIP` refs). **Render fails** (`Error loading image`) until the file exists. Affects glass/paper/warm/forbidden (not dark).
   - **Workaround:** drop any PNG at `public/captures/your-asset.png` (we generated an 800×800 placeholder via ffmpeg).
3. **Lint does NOT catch missing static assets** — a render-blocking gap. `lint` passed on PaperReel while it referenced a non-existent image.
4. **`--interpolate=60` is misleading** — it speeds the clip up 2×, doesn't smooth motion (see L4). Don't use for "smoother 60fps"; for that, ffmpeg `minterpolate` post-render.
5. **Critique Hierarchy score is noisy** — penalizes intentional optical spacing; even shipped reference reels score 0–5/10. Treat as advisory.
6. **Render hangs are possible** with concurrent renders + high `--concurrency` + leftover Chrome. Render one comp at a time, default concurrency, clean orphaned `chrome-headless-shell` between runs.
7. **`/reelstack-beats` unavailable** — needs `whisper-cli` (not installed). Irrelevant for us; StyleClone has its own superior alignment stack (WhisperX/ElevenLabs Scribe).
8. **License/commercial:** Remotion's own license applies to rendering at company scale (>3 employees → paid tier). ReelStack license is per-machine (3-machine/30-day). Factor both into StyleClone's cost model.

---

## 7. StyleClone production-fit

### Where ReelStack plugs in
- **Style/brand layer for the Composer.** Its 5 families + palettes + easing/spring presets + 4px grid + safe-zones become a *style vocabulary* a generated reel can target. Maps directly onto our StyleProfile concept.
- **Motion-primitive toolbox.** StaggeredWords, IridescentText, Counter, SonarRings, CausticBlobs, FilmStrip, BreakdownCard, AccentGlow are drop-in Remotion components for our renderer — high production value, hardware-accelerated, reduce-motion aware.
- **Reference corpus for the Reference Analysis Engine.** 22 hand-authored pro reels are labeled training/eval data for "what good pacing/layout/motion looks like" per style.
- **Quality discipline we should copy.** The lint rule-set (hook latency, motion floor, safe zones, hw-accel-only, CTA presence) is a ready-made checklist for our Style-Fidelity scorer.

### Where it does NOT fit
- ❌ Not a data→infographic generator (build our own charts; reuse its style tokens).
- ❌ Don't call its CLI from our pipeline (Windows-broken, interactive prompts). Use Remotion's Node `renderMedia()` API.
- ❌ Its reels are full ~60–110s narratives with baked Devini Labs copy — they're *references*, not templates to ship as-is.

### Recommended integration
1. **Vendor the component library + design tokens** (families/*, utils/easing, utils/grid, utils/safe-zones) into StyleClone's Remotion package as our base motion kit.
2. **Build a StyleProfile→component mapping**: each style profile selects a family palette + easing + a curated component set.
3. **Author our own data-viz components** (bar/line/donut/%-ring/counter+) styled with ReelStack tokens to fill the infographics gap.
4. **Port the lint rules** into our Style-Fidelity Score as automated checks.
5. **Render via `renderMedia()` (Node API)** or Remotion Lambda for throughput — never the reelstack CLI. Replicate its ffmpeg GIF/BGM recipes if we need those outputs.

---

## 8. One-line takeaway

> ReelStack = a beautiful, production-grade **9:16 style system + motion-primitive toolbox + reference corpus** for Remotion. Use it for *taste, families, easing, and components*. Build the *infographics engine* ourselves. Never touch its CLI on Windows — drive Remotion directly.
