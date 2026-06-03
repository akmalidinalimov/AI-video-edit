export const meta = {
  name: 'style-director',
  description: 'Replicate a reference reel\'s editing/motion style onto the user\'s A-roll/B-roll: decode → plan → build (Remotion) → render → verify (style-fidelity) → loop to a fidelity target.',
  phases: [
    { title: 'Decode',  detail: 'reference-decode.mjs + per-shot Analyst subagents read frames → shotplan' },
    { title: 'Plan',    detail: 'Editor places A/B-roll on the timeline; Motion-Designer attaches Remotion motion recipes; B-roll router' },
    { title: 'Build',   detail: 'Remotion-Engineer writes/patches the composition from the shotplan' },
    { title: 'Render',  detail: 'render the composition' },
    { title: 'Verify',  detail: 'style-fidelity + gates; Fidelity-QA triages punch-list' },
    { title: 'Iterate', detail: 'route fixes → re-build → re-render → re-score until score ≥ target or maxIters' },
  ],
};

// ── inputs (via Workflow `args`) ──
const A = args || {};
const REFERENCE   = A.reference   || 'public/uploads/references/IMG_6298.MP4';
const REF_ID      = A.refId       || 'img6298';
const AROLL_DIR   = A.arollDir    || '';
const BROLL_DIR   = A.brollDir    || '';
const COMP_ID     = A.compositionId || 'Reel2Video';
const ENTRY       = A.entry       || 'src/remotion/entry.tsx';
const PROPS       = A.propsPath   || 'public/exports/reel2/reel2-props.json';
const OUT_MP4     = A.outMp4      || 'public/exports/reel2/reel2.mp4';
const TARGET      = A.target      ?? 85;
const MAX_ITERS   = A.maxIters    ?? 4;
const PAIRS       = A.pairs       || '';   // style-fidelity --pairs alignment (out:ref,...)

// ── schemas ──
const SHOT_SPEC = {
  type: 'object', required: ['shotId', 'layout', 'cameraMotion', 'elementMotion'],
  properties: {
    shotId: { type: 'string' }, startSec: { type: 'number' }, endSec: { type: 'number' },
    layout: { type: 'string', description: 'precise on-screen layout: where A-roll/B-roll/text sit, sizes, safe areas' },
    cameraMotion: { type: 'string' }, elementMotion: { type: 'string' },
    typography: { type: 'string' }, colorGrade: { type: 'string' }, transitionIn: { type: 'string' },
    notes: { type: 'string', description: 'exact reproduction hints from the FRAMES (not text guesses)' },
  },
};
const MOTION_RECIPE = {
  type: 'object', required: ['shotId', 'patterns'],
  properties: {
    shotId: { type: 'string' },
    patterns: { type: 'array', items: { type: 'object', required: ['name', 'params'],
      properties: { name: { type: 'string' }, params: { type: 'object' } } } },
    notes: { type: 'string' },
  },
};
const FIDELITY = {
  type: 'object', required: ['overall', 'lowestDims', 'punchList'],
  properties: {
    overall: { type: 'number' },
    lowestDims: { type: 'array', items: { type: 'string' } },
    punchList: { type: 'array', items: { type: 'object', required: ['issue', 'route'],
      properties: { issue: { type: 'string' }, dim: { type: 'string' },
        route: { type: 'string', enum: ['motion-designer', 'remotion-engineer', 'editor', 'broll-director', 'color'] },
        fix: { type: 'string' } } } },
  },
};

// ════════════════ DECODE ════════════════
phase('Decode');
const decode = await agent(
  `Run the reference decoder and report the result. Execute via Bash:\n` +
  `  node scripts/reference-decode.mjs ${REFERENCE} --id ${REF_ID}\n` +
  `Then read public/exports/refanalysis/${REF_ID}/recipe.json and return ONLY this JSON: ` +
  `{ "recipePath": "...", "framesDir": "...", "shots": [ {shotId,startSec,endSec,summary,cameraMotion,elementMotion,tool} ], "fingerprint": {...} }. ` +
  `Do not summarize in prose — return the JSON object.`,
  { label: 'decode', phase: 'Decode', schema: {
    type: 'object', required: ['recipePath', 'shots'],
    properties: { recipePath: { type: 'string' }, framesDir: { type: 'string' },
      shots: { type: 'array', items: { type: 'object' } }, fingerprint: { type: 'object' } } } }
);
log(`Decoded ${decode?.shots?.length || 0} shots from ${REF_ID}`);

// per-shot Analyst subagents read the SAVED FRAMES (multimodal) → precise shot spec (frames-first, no CV yet)
const shots = (decode?.shots || []).map((s, i) => ({ ...s, shotId: s.shotId || `shot${i}` }));
const shotSpecs = (await parallel(shots.map((s) => () =>
  agent(
    `You are a Reference-Analyst. Look at the decoded reference shot ${s.shotId} [${s.startSec}-${s.endSec}s]: "${s.summary}". ` +
    `Open the saved frames in ${decode?.framesDir || `public/exports/refanalysis/${REF_ID}/frames`} that fall in this shot's time range (read 2-3 of them as IMAGES with the Read tool) ` +
    `and the contact sheets, and produce a PRECISE, visually-grounded shot spec. Capture exact layout, camera motion, element/motion, typography, color grade, and transition-in — from what you SEE, not from the text summary.`,
    { label: `analyst:${s.shotId}`, phase: 'Decode', schema: SHOT_SPEC }
  ).then(spec => ({ ...s, ...spec, shotId: s.shotId }))
))).filter(Boolean);
log(`Analysts produced ${shotSpecs.length} grounded shot specs`);

// ════════════════ PLAN ════════════════
phase('Plan');
// Editor: map the user's A-roll/B-roll onto the reference timeline (placement, cut rhythm, pacing)
const editPlan = await agent(
  `You are a senior video Editor. Given these reference shot specs:\n${JSON.stringify(shotSpecs).slice(0, 6000)}\n` +
  `and the user's assets (A-roll dir: "${AROLL_DIR || '(existing reel-2 turns)'}", B-roll dir: "${BROLL_DIR || '(none — generate)'}"), ` +
  `produce a timeline that maps OUR content onto the reference's structure: for each shot, which user asset (or "generate B-roll"/"motion-graphics") fills it, the cut rhythm, and pacing. ` +
  `Honor sentence boundaries for any talking-head A-roll. Return JSON {timeline:[{shotId, fill, assetHint, needsBroll, notes}]}.`,
  { label: 'editor', phase: 'Plan', schema: { type: 'object', required: ['timeline'],
    properties: { timeline: { type: 'array', items: { type: 'object' } } } } }
);

// Motion-Designer: attach a Remotion motion recipe to each shot (uses docs/motion-library via the motion-designer skill)
const motionRecipes = (await parallel(shotSpecs.map((s) => () =>
  agent(
    `You are the Motion-Designer (use the motion-designer skill + docs/motion-library/). For reference shot ${s.shotId}: ` +
    `cameraMotion="${s.cameraMotion}", elementMotion="${s.elementMotion}", transitionIn="${s.transitionIn || ''}". ` +
    `Map each motion signal to a library pattern and emit a motion recipe {shotId, patterns:[{name, params}], notes} with concrete params (frames/easing/scale).`,
    { label: `motion:${s.shotId}`, phase: 'Plan', schema: MOTION_RECIPE }
  )
))).filter(Boolean);
log(`Motion recipes for ${motionRecipes.length} shots`);

// B-roll routing for shots that need it (cost-aware; generation executed by B-roll-Director below)
const needsBroll = (editPlan?.timeline || []).filter(t => t.needsBroll);
if (needsBroll.length) {
  await agent(
    `You are the B-roll-Director. For these shots needing B-roll: ${JSON.stringify(needsBroll).slice(0, 3000)}\n` +
    `1) Build a directives JSON and run \`node scripts/broll-engine.mjs <file> --dry-run\` to get cost-aware routing (stock → Kling 3.0 1080p default → Seedance 2.0 720p only if needsVideoReference). ` +
    `2) For STOCK beats, fetch via the engine (Pexels). For GENERATE beats, call MCP generate_video with the routed model, then run the cleanliness gate (scripts/lib/broll/ + reel2-anatomy-gate.mjs). ` +
    `Keep cost minimal (prefer Kling 1080p; Seedance only when flagged). Return JSON {brollAssets:[{shotId, file, source, costUsd}]}.`,
    { label: 'broll-director', phase: 'Plan', schema: { type: 'object',
      properties: { brollAssets: { type: 'array', items: { type: 'object' } } } } }
  );
}

// ════════════════ BUILD → RENDER → VERIFY → ITERATE (the convergence loop) ════════════════
let iter = 0, score = 0, lastReport = null;
let buildBrief =
  `Build/patch the Remotion composition "${COMP_ID}" (entry ${ENTRY}) to match the reference shot specs + motion recipes.\n` +
  `Shot specs: ${JSON.stringify(shotSpecs).slice(0, 5000)}\n` +
  `Motion recipes: ${JSON.stringify(motionRecipes).slice(0, 4000)}\n` +
  `Edit plan: ${JSON.stringify(editPlan?.timeline || []).slice(0, 3000)}\n` +
  `Use the remotion-best-practices skill + our gotchas (OffthreadVideo w/ 120s timeout, loop short clips, fade only segment 0, NO CSS transitions, frame-aligned ranges). Compositions live in src/remotion/compositions/.\n` +
  `GUARDRAIL — never clobber source assets: do ALL visual changes (crop, zoom, grade, reframe) IN the composition via CSS transform/objectFit/filter. NEVER re-encode or overwrite a source clip in public/uploads/** in place (they are gitignored originals WITH AUDIO — re-encoding drops the audio track and there is no undo). If you genuinely need a transformed clip on disk, write it to a NEW path and update props to point at it.`;

while (iter < MAX_ITERS) {
  iter++;
  phase(iter === 1 ? 'Build' : 'Iterate');
  await agent(
    `You are the Remotion-Engineer (iteration ${iter}). ${buildBrief}\n` +
    `Edit the composition source files to implement this. Do NOT render yet — just make the code changes and confirm they typecheck/compile.`,
    { label: `build#${iter}`, phase: iter === 1 ? 'Build' : 'Iterate' }
  );

  phase(iter === 1 ? 'Render' : 'Iterate');
  await agent(
    `Render the composition via Bash:\n` +
    `  npx remotion render ${ENTRY} ${COMP_ID} ${OUT_MP4} --props=${PROPS} --concurrency=2 --timeout=120000\n` +
    `Report whether it reached "Encoded N/N" and the output path. If it errors, report the error verbatim.`,
    { label: `render#${iter}`, phase: iter === 1 ? 'Render' : 'Iterate' }
  );

  phase('Verify');
  const verify = await agent(
    `Run the verification gates via Bash and report results as JSON:\n` +
    `  node scripts/style-fidelity.mjs ${OUT_MP4} --ref ${REF_ID}${PAIRS ? ` --pairs "${PAIRS}"` : ''}\n` +
    `  node scripts/reel2-cut-check.mjs ; node scripts/reel2-crop-check.mjs ; node scripts/reel2-audio-check.mjs ; node scripts/test-regression.mjs\n` +
    `Read the written style-fidelity-report.json. Return {overall, lowestDims, punchList:[{issue,dim,route,fix}], gates:{cut,crop,audio,regression}}. ` +
    `HARD GATE: if reel2-audio-check.mjs exits non-zero, a talking segment went SILENT (usually a source ` +
    `clip got clobbered/muted) — this is a BLOCKING regression. Do NOT report the iteration as improved; ` +
    `add it to the punchList (route "editor", fix "restore the silenced segment's source-clip audio") and ` +
    `set gates.audio=false. The frame-only style score can rise while audio is broken — the audio gate is authoritative for sound. ` +
    `Route each punch-list item to the responsible role: motion-designer | remotion-engineer | editor | broll-director | color.`,
    { label: `verify#${iter}`, phase: 'Verify', schema: FIDELITY }
  );
  score = verify?.overall ?? 0;
  lastReport = verify;
  log(`Iteration ${iter}: style-fidelity ${score}/100 (target ${TARGET}). Lowest: ${(verify?.lowestDims || []).join(', ')}`);

  if (score >= TARGET) { log(`✅ Target reached at iteration ${iter}.`); break; }
  if (iter >= MAX_ITERS) { log(`⚠️ Stopped at maxIters=${MAX_ITERS} with ${score}/100.`); break; }

  // route the top fixes back into the build brief for the next iteration
  const top = (verify?.punchList || []).slice(0, 6);
  buildBrief =
    `Iteration ${iter + 1}: apply these prioritized fixes to raise style-fidelity (was ${score}/100, lowest: ${(verify?.lowestDims || []).join(', ')}):\n` +
    top.map((p, i) => `  ${i + 1}. [${p.route}] ${p.issue} → ${p.fix || ''}`).join('\n') +
    `\nFocus on layout/composition/motion first (highest-leverage). Keep all gates green (cut/crop/regression). Re-use docs/motion-library for any motion changes.`;
  log(`Routed ${top.length} fixes for iteration ${iter + 1}.`);
}

return {
  refId: REF_ID, iterations: iter, finalScore: score, target: TARGET,
  reached: score >= TARGET, output: OUT_MP4, lastReport,
};
