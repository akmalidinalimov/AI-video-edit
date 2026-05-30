/**
 * Narrative Analyzer — Deep Content-Aware Intelligence Layer
 *
 * V2: Full 5-improvement implementation:
 *   #1 — B-roll OCR text flows through to matching (visibleText on scenes)
 *   #2 — Dense frame sampling awareness (handled by materialAnalyzer)
 *   #3 — Cross-modal verification pass (verifyMatches)
 *   #4 — Speech keyword extraction (extractSpeechKeywords)
 *   #5 — Narrative arc alignment (phase-constrained matching in analyzeNarrativeContext)
 *
 * This module:
 * 1. Extracts specific product/feature keywords from each sentence
 * 2. Builds a narrative arc across all A-roll clips
 * 3. Classifies B-roll scenes into matching narrative phases
 * 4. Produces a relevance map that combines keyword matching, OCR matching,
 *    and narrative alignment into a single score
 * 5. Verifies (sentence, B-roll) match quality after initial assignment
 *
 * ARCHITECTURE:
 * - 3 Gemini Flash calls total:
 *   1. Speech keyword extraction (fast, text-only)
 *   2. Full narrative analysis with OCR + phase alignment
 *   3. Cross-modal verification of matched pairs (optional quality gate)
 */

import { geminiFlash } from "@/lib/gemini/client";
import type { NarrativeContext, BRollScene } from "./plan-builder";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface ArollClipSummary {
  /** Index of this clip in the upload sequence */
  clipIndex: number;
  /** Full transcription text */
  fullText: string;
  /** Sentences with indices (global across all clips) */
  sentences: Array<{
    globalIndex: number;
    text: string;
    semanticTags?: string[];
    /** Extracted keywords: product names, feature names, action verbs */
    keywords?: string[];
  }>;
}

export interface BrollSceneSummary {
  /** Global scene index (across all B-roll sources) */
  sceneIndex: number;
  /** Which B-roll source this came from */
  sourceIndex: number;
  /** Content tags from frame analysis */
  contentTags: string[];
  /** OCR text extracted from frames in this scene */
  visibleText?: string[];
  /** UI elements detected */
  uiElements?: string[];
  /** Human-readable description */
  description: string;
  /** Duration of this scene */
  duration: number;
  /** Per-frame content data for precise trimming (Improvement #2) */
  frameContent?: Array<{
    timestamp: number;
    visibleText?: string[];
    contentTags: string[];
  }>;
}

/** Result of speech keyword extraction (#4) */
export interface SpeechKeywords {
  sentences: Array<{
    index: number;
    keywords: string[];
    featureNames: string[];
    actionVerbs: string[];
  }>;
}

/** Result of cross-modal verification (#3) */
export interface VerificationResult {
  pairs: Array<{
    sentenceIndex: number;
    sceneIndex: number;
    score: number;       // 0-100
    isGoodMatch: boolean; // score >= 70
    suggestion?: string;  // if not a good match, what to look for instead
  }>;
  overallScore: number;
}

// ════════════════════════════════════════════════════════════
// IMPROVEMENT #4: SPEECH KEYWORD EXTRACTION
// ════════════════════════════════════════════════════════════

/**
 * Extract specific product names, feature names, and action verbs from each sentence.
 * These keywords are the PRIMARY matching signal — much more precise than generic
 * semantic tags like "product" or "demo".
 *
 * @param transcription - Full text and sentences
 * @returns Keywords per sentence
 */
export async function extractSpeechKeywords(
  sentences: Array<{ index: number; text: string }>
): Promise<SpeechKeywords> {
  const sentenceList = sentences
    .map((s) => `  [S${s.index}] "${s.text}"`)
    .join("\n");

  const prompt = `You are a content analysis expert. Extract specific keywords from each sentence that could match against visual content in a screen recording or demo video.

For each sentence, extract:
1. **keywords**: ALL meaningful nouns, proper nouns, and compound terms (e.g., "analytics dashboard", "competitor analysis", "AI agent")
2. **featureNames**: Specific product features or tool names mentioned (e.g., "virality prediction", "content scheduler", "Chat Place")
3. **actionVerbs**: What actions are described (e.g., "analyze", "create", "schedule", "predict")

IMPORTANT: Extract keywords in BOTH the original language AND English translation if the text is not English. This ensures matching against UI text that may be in either language.

SENTENCES:
${sentenceList}

Return JSON:
{
  "sentences": [
    {
      "index": 0,
      "keywords": ["SMM", "mutaxassis", "specialist", "2026"],
      "featureNames": ["SMM specialist"],
      "actionVerbs": []
    }
  ]
}`;

  try {
    const result = await geminiFlash.generateContent([{ text: prompt }]);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as SpeechKeywords;

    console.log(`[SpeechKeywords] Extracted keywords for ${parsed.sentences?.length ?? 0} sentences`);
    return parsed;
  } catch (err) {
    console.error("[SpeechKeywords] Failed:", err);
    return { sentences: [] };
  }
}

// ════════════════════════════════════════════════════════════
// IMPROVEMENT #1 + #5: ENHANCED NARRATIVE ANALYSIS
//   Now includes OCR text and narrative phase alignment
// ════════════════════════════════════════════════════════════

/**
 * Analyze the narrative structure across all A-roll and B-roll content.
 *
 * Enhanced V2: Now includes:
 * - OCR text from B-roll scenes for precise keyword matching
 * - Narrative phase classification for BOTH sentences AND scenes
 * - Phase-constrained relevance scoring
 * - Speech keywords as a matching signal
 *
 * @param arollClips - Summaries of all A-roll transcriptions in sequence order
 * @param brollScenes - Summaries of all B-roll scenes from all sources (with OCR text)
 * @param speechKeywords - Pre-extracted keywords per sentence (from extractSpeechKeywords)
 * @returns NarrativeContext with relevance map
 */
export async function analyzeNarrativeContext(
  arollClips: ArollClipSummary[],
  brollScenes: BrollSceneSummary[],
  speechKeywords?: SpeechKeywords
): Promise<NarrativeContext> {
  // Merge speech keywords into clip summaries
  if (speechKeywords?.sentences) {
    const kwMap = new Map(speechKeywords.sentences.map((s) => [s.index, s]));
    for (const clip of arollClips) {
      for (const sentence of clip.sentences) {
        const kw = kwMap.get(sentence.globalIndex);
        if (kw) {
          sentence.keywords = [...kw.keywords, ...kw.featureNames];
        }
      }
    }
  }

  // Build prompt sections
  const arollSection = arollClips.map((clip) => {
    const sentenceList = clip.sentences
      .map((s) => {
        const tags = s.semanticTags?.length ? ` (tags: ${s.semanticTags.join(", ")})` : "";
        const kw = s.keywords?.length ? ` [keywords: ${s.keywords.join(", ")}]` : "";
        return `  [S${s.globalIndex}] "${s.text}"${tags}${kw}`;
      })
      .join("\n");
    return `--- A-roll Clip #${clip.clipIndex + 1} ---\n${clip.fullText}\n\nSentences:\n${sentenceList}`;
  }).join("\n\n");

  // Include OCR text and UI elements in B-roll descriptions
  const brollSection = brollScenes.map((scene) => {
    const ocrInfo = scene.visibleText?.length
      ? ` | OCR text: [${scene.visibleText.slice(0, 10).join(", ")}]`
      : "";
    const uiInfo = scene.uiElements?.length
      ? ` | UI: [${scene.uiElements.slice(0, 5).join(", ")}]`
      : "";
    return `  [B${scene.sceneIndex}] Source #${scene.sourceIndex + 1} | ${scene.duration.toFixed(1)}s | Tags: [${scene.contentTags.join(", ")}]${ocrInfo}${uiInfo} | "${scene.description}"`;
  }).join("\n");

  const totalSentences = arollClips.reduce((sum, c) => sum + c.sentences.length, 0);
  const totalScenes = brollScenes.length;

  const prompt = `You are a video editing intelligence that deeply understands narrative structure and content matching.

TASK: Analyze the A-roll speech content and B-roll visual content below. Produce a narrative context map with phase alignment and keyword-aware matching.

═══ A-ROLL CONTENT (${arollClips.length} clip(s), ${totalSentences} sentences) ═══
${arollSection}

═══ B-ROLL SCENES (${totalScenes} scene(s)) ═══
${brollSection}

═══ MATCHING RULES ═══

1. Identify the overall THEME
2. Identify NARRATIVE PHASES across A-roll sentences AND classify each B-roll scene into a phase:
   - Phases: hook, problem, solution, demo, feature_highlight, social_proof, cta, transition, general
   - Each B-roll scene should be tagged with the phase it best fits

3. For EACH sentence, rank the TOP 3 most relevant B-roll scenes. SCORING CRITERIA (in priority order):
   a. **KEYWORD MATCH (highest priority)**: Does the B-roll's OCR text contain words from the sentence's keywords?
      Example: Sentence mentions "analytics" → B-roll OCR shows "Analytics Dashboard" → score 90+
   b. **VISUAL SUPPORT**: Does the B-roll show what's being discussed?
      Example: Sentence talks about "competitor analysis feature" → B-roll shows competitor analysis screen → score 80+
   c. **PHASE ALIGNMENT**: Is the B-roll scene in the same narrative phase as the sentence?
      Example: "hook" sentence should prefer "hook/problem" B-roll over "cta" B-roll → +15 bonus
   d. **CONTEXT RELEVANCE**: Does the B-roll provide meaningful context for abstract statements?
   e. **VARIETY**: Avoid showing the same B-roll scene for 3+ consecutive sentences

4. Classify each B-roll scene into a narrative phase in the "scenePhases" field.

Return JSON:
{
  "theme": "brief description of overall content theme",
  "narrativePhases": [
    {
      "phase": "hook",
      "sentenceIndices": [0, 1],
      "description": "Opening that grabs attention"
    }
  ],
  "scenePhases": [
    { "sceneIndex": 0, "phase": "demo", "reason": "Shows the main app interface" }
  ],
  "relevanceMap": [
    {
      "sentenceIndex": 0,
      "rankedScenes": [
        { "sceneIndex": 2, "relevanceScore": 95, "reason": "OCR text 'Competitor Analysis' matches keyword 'competitor analysis'", "matchType": "keyword" },
        { "sceneIndex": 0, "relevanceScore": 60, "reason": "General app overview matches theme", "matchType": "visual" }
      ]
    }
  ]
}

RULES:
- relevanceScore is 0-100 (100 = perfect keyword + visual match)
- matchType: "keyword" (OCR/keyword match), "visual" (visual support), "phase" (phase alignment), "context" (general context)
- Include up to 3 rankedScenes per sentence, only if relevanceScore > 20
- CRITICAL: When B-roll OCR text contains a word from the sentence's keywords, score MUST be 85+
- Return ONLY valid JSON`;

  try {
    const result = await geminiFlash.generateContent([{ text: prompt }]);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as NarrativeContext & {
      scenePhases?: Array<{ sceneIndex: number; phase: string; reason: string }>;
    };

    console.log(`[NarrativeAnalyzer] Theme: "${parsed.theme}"`);
    console.log(`[NarrativeAnalyzer] Phases: ${parsed.narrativePhases?.length ?? 0}`);
    console.log(`[NarrativeAnalyzer] Scene phases: ${parsed.scenePhases?.length ?? 0}`);
    console.log(`[NarrativeAnalyzer] Relevance entries: ${parsed.relevanceMap?.length ?? 0}`);

    // Store scene phases in the context for downstream use
    const context: NarrativeContext = {
      theme: parsed.theme ?? "unknown",
      narrativePhases: parsed.narrativePhases ?? [],
      relevanceMap: (parsed.relevanceMap ?? []).filter(
        (entry) => typeof entry.sentenceIndex === "number" && Array.isArray(entry.rankedScenes)
      ),
    };

    // Attach scene phases to context for phase-constrained matching
    if (parsed.scenePhases?.length) {
      (context as unknown as Record<string, unknown>).scenePhases = parsed.scenePhases;
    }

    return context;
  } catch (err) {
    console.error("[NarrativeAnalyzer] Failed:", err);
    return {
      theme: "unknown",
      narrativePhases: [],
      relevanceMap: [],
    };
  }
}

// ════════════════════════════════════════════════════════════
// IMPROVEMENT #3: CROSS-MODAL VERIFICATION
// ════════════════════════════════════════════════════════════

/**
 * Verify that matched (sentence, B-roll scene) pairs actually make sense.
 *
 * After the initial matching in the plan builder, this function checks each
 * pairing by asking Gemini: "Does this B-roll scene visually support this
 * sentence?" Any pair scoring below 70% gets flagged for re-matching.
 *
 * @param matches - Array of (sentence text, matched B-roll scene summary) pairs
 * @returns Verification scores and suggestions for bad matches
 */
export async function verifyMatches(
  matches: Array<{
    sentenceIndex: number;
    sentenceText: string;
    sceneIndex: number;
    sceneDescription: string;
    sceneTags: string[];
    sceneOcrText?: string[];
  }>
): Promise<VerificationResult> {
  if (matches.length === 0) {
    return { pairs: [], overallScore: 100 };
  }

  const pairList = matches.map((m) => {
    const ocrInfo = m.sceneOcrText?.length ? ` OCR: [${m.sceneOcrText.slice(0, 5).join(", ")}]` : "";
    return `  [S${m.sentenceIndex} → B${m.sceneIndex}] Speech: "${m.sentenceText}" | B-roll: "${m.sceneDescription}" Tags: [${m.sceneTags.join(", ")}]${ocrInfo}`;
  }).join("\n");

  const prompt = `You are a video editing quality checker. Verify whether each (speech, B-roll) pair below makes a good visual match.

For each pair, score 0-100:
- 90-100: Perfect match — B-roll directly shows what's being discussed
- 70-89: Good match — B-roll is relevant and supports the speech
- 50-69: Weak match — B-roll is tangentially related
- 0-49: Bad match — B-roll doesn't support the speech at all

PAIRS TO VERIFY:
${pairList}

Return JSON:
{
  "pairs": [
    {
      "sentenceIndex": 0,
      "sceneIndex": 2,
      "score": 85,
      "isGoodMatch": true,
      "suggestion": null
    },
    {
      "sentenceIndex": 1,
      "sceneIndex": 0,
      "score": 35,
      "isGoodMatch": false,
      "suggestion": "Look for B-roll showing the signup process instead"
    }
  ]
}`;

  try {
    const result = await geminiFlash.generateContent([{ text: prompt }]);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as VerificationResult;

    const scores = (parsed.pairs ?? []).map((p) => p.score);
    const overallScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 100;

    const goodCount = (parsed.pairs ?? []).filter((p) => p.isGoodMatch).length;
    const totalCount = (parsed.pairs ?? []).length;

    console.log(`[MatchVerification] ${goodCount}/${totalCount} good matches, overall=${overallScore}%`);

    return {
      pairs: parsed.pairs ?? [],
      overallScore,
    };
  } catch (err) {
    console.error("[MatchVerification] Failed:", err);
    return { pairs: [], overallScore: 100 };
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Build A-roll clip summaries from multiple transcriptions.
 */
export function buildArollSummaries(
  transcriptions: Array<{
    sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
  }>
): { summaries: ArollClipSummary[]; totalSentences: number } {
  const summaries: ArollClipSummary[] = [];
  let globalIndex = 0;

  for (let clipIdx = 0; clipIdx < transcriptions.length; clipIdx++) {
    const trans = transcriptions[clipIdx];
    const sentences = trans.sentences.map((s) => ({
      globalIndex: globalIndex++,
      text: s.text,
      semanticTags: s.semantic_tags,
    }));

    summaries.push({
      clipIndex: clipIdx,
      fullText: trans.sentences.map((s) => s.text).join(" "),
      sentences,
    });
  }

  return { summaries, totalSentences: globalIndex };
}

/**
 * Build B-roll scene summaries from multiple analyses.
 * Now includes visibleText, uiElements for OCR matching (#1),
 * and frameContent for per-sentence trimming (#2).
 */
export function buildBrollSummaries(
  analyses: Array<{
    internalScenes: Array<{
      start: number;
      end: number;
      description: string;
      contentTags: string[];
      visibleText?: string[];
      uiElements?: string[];
      frameContent?: Array<{
        timestamp: number;
        visibleText?: string[];
        contentTags: string[];
      }>;
    }>;
  }>
): BrollSceneSummary[] {
  const summaries: BrollSceneSummary[] = [];
  let globalIndex = 0;

  for (let sourceIdx = 0; sourceIdx < analyses.length; sourceIdx++) {
    const analysis = analyses[sourceIdx];
    for (const scene of analysis.internalScenes) {
      summaries.push({
        sceneIndex: globalIndex++,
        sourceIndex: sourceIdx,
        contentTags: scene.contentTags,
        visibleText: scene.visibleText,
        uiElements: scene.uiElements,
        description: scene.description,
        duration: scene.end - scene.start,
        frameContent: scene.frameContent,
      });
    }
  }

  return summaries;
}

/**
 * Convert B-roll scene summaries back into BRollScene format for the plan builder.
 */
export function summariesToBrollScenes(
  summaries: BrollSceneSummary[],
  analyses: Array<{
    internalScenes: Array<{
      start: number;
      end: number;
      description: string;
      contentTags: string[];
    }>;
  }>
): BRollScene[] {
  return summaries.map((summary) => {
    const source = analyses[summary.sourceIndex];
    const sceneInSource = source.internalScenes.find(
      (s) => s.description === summary.description && s.contentTags.length === summary.contentTags.length
    ) ?? source.internalScenes[0];

    return {
      start: sceneInSource?.start ?? 0,
      end: sceneInSource?.end ?? summary.duration,
      contentTags: summary.contentTags,
      description: summary.description,
      sourceIndex: summary.sourceIndex,
      visibleText: summary.visibleText,
      frameContent: summary.frameContent,
    };
  });
}
