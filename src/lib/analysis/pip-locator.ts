/**
 * PIP Locator — per-segment FACE-ANCHORED identification of the speaker's
 * circular picture-in-picture overlay in a reference video.
 *
 * THIS MODULE EXISTS BECAUSE (see .knowledge/measurement-rules.json):
 *
 *   KB-001 The LLM's layout-class label ("circle_pip_top_right") is unreliable
 *          as a search constraint.
 *
 *   KB-002 Full-canvas Hough circle search admits false circles from B-roll
 *          content (profile thumbnails, app avatars).
 *
 *   KB-005 (draft) Gemini Vision's "where is the PIP" coordinate query returns
 *          centers with 100-220 px systematic error and a "safe middle" bias.
 *          The error often exceeds CV refine pads → CV falls back to the
 *          wrong seed.
 *
 * RESOLUTION (option C from session 2026-05-30 retro):
 * Bypass coordinate queries. Ask Gemini for the SPEAKER'S FACE bounding box
 * instead. Face detection is a much more constrained spatial task than
 * arbitrary circle detection — Gemini's training on millions of face-localized
 * images gives it strong anatomical priors (eyes/nose/mouth as anchors) that
 * generic "where is the PIP" queries lack.
 *
 * Once we have the face bbox, the PIP circle is GEOMETRICALLY derived:
 *   - The face fills ~80 % of the PIP diameter (head + hijab top-to-chin)
 *   - PIP center is ~0.13 * face_height below face center (PIP extends down
 *     to include neck + shoulders)
 *   - Radius = face_height * 0.65
 *
 * Three frames per segment, median over the detections, to absorb per-frame
 * face-detection noise.
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { geminiFlash } from "@/lib/gemini/client";

export interface PipSeed {
  /** PIP circle center X derived from face center. */
  cx: number;
  cy: number;
  radius: number;
  confidence: number;
  reasoning?: string;
}

export interface PipLocatorInput {
  ffmpegPath: string;
  refVideoPath: string;
  canvas: { width: number; height: number };
  segments: Array<{ id: string; start: number; end: number }>;
  tmpDir: string;
  /** Frames sampled per segment to median over. Default 3. */
  framesPerSegment?: number;
}

function extractFrame(
  ffmpegPath: string,
  video: string,
  t: number,
  canvas: { width: number; height: number },
  outPath: string
): boolean {
  const r = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-ss", String(t),
      "-i", video,
      "-frames:v", "1",
      "-vf", `scale=${canvas.width}:${canvas.height}`,
      outPath,
    ],
    { encoding: "utf-8" }
  );
  return r.status === 0 && fs.existsSync(outPath);
}

function readImageAsBase64(p: string): string {
  return fs.readFileSync(p).toString("base64");
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function buildFacePrompt(canvas: { width: number; height: number }): string {
  return `You are looking at a single still frame from a video, ${canvas.width}x${canvas.height} pixels (portrait 9:16).

The frame shows a SPEAKER addressing the camera. The speaker is a woman wearing EYEGLASSES and a HIJAB (headscarf). Her face appears inside a circular picture-in-picture (PIP) overlay positioned on top of background app content (TikTok grids, chat interfaces, app menus, etc.).

YOUR JOB: return the SPEAKER'S FACE bounding box in canvas pixels.

CRITICAL DISAMBIGUATION (multiple faces may be visible — pick only the speaker):
  • Background content frequently shows OTHER faces in profile thumbnails, TikTok cards, or chat avatars. DO NOT pick those.
  • The SPEAKER is identified by ALL of these characteristics together:
      - Wearing EYEGLASSES (clearly visible black frames)
      - Wearing a HIJAB / headscarf (light cream or beige fabric covering hair)
      - Inside a clear circular PIP border ring
      - SIGNIFICANTLY LARGER than any background face thumbnails
      - Looking at the camera (front-facing, addressing viewer)
  • If you see multiple women in hijabs, pick the LARGEST face that is inside a circular border.
  • If you cannot identify the speaker's face with reasonable confidence, return confidence < 0.4 so the downstream step knows to widen its search.

COORDINATES: canvas pixel space, top-left origin.
  - face_x: left edge of the face bounding box (0 = left edge of canvas, ${canvas.width} = right edge)
  - face_y: top edge of the face bounding box (top of hijab/forehead, NOT top of circle border)
  - face_width: width of face bounding box
  - face_height: height of face bounding box (top of hijab to chin)

OUTPUT (JSON only, no prose, no markdown fence):
{
  "face_x": <number>,
  "face_y": <number>,
  "face_width": <number>,
  "face_height": <number>,
  "confidence": <0..1>,
  "reasoning": "<one short sentence identifying the speaker's face>"
}`;
}

/**
 * Convert a face bbox to a PIP circle seed via geometric heuristic.
 *
 * Observations from reference video analysis:
 *   - The face fills ~80 % of the PIP diameter
 *   - The PIP center is slightly below the face center (PIP extends
 *     downward to include neck + shoulder)
 *   - Radius ≈ face_height * 0.65
 */
function faceToCircle(face: {
  face_x: number;
  face_y: number;
  face_width: number;
  face_height: number;
}): { cx: number; cy: number; radius: number } {
  const faceCx = face.face_x + face.face_width / 2;
  const faceCy = face.face_y + face.face_height / 2;
  // PIP center is slightly below face center (PIP extends to shoulders)
  const cx = Math.round(faceCx);
  const cy = Math.round(faceCy + face.face_height * 0.13);
  // Radius derived from face height (face fills ~80% of PIP diameter)
  const radius = Math.round(face.face_height * 0.65);
  return { cx, cy, radius };
}

interface FaceDet {
  face_x: number;
  face_y: number;
  face_width: number;
  face_height: number;
  confidence: number;
  reasoning?: string;
}

async function detectSpeakerFace(
  framePath: string,
  prompt: string
): Promise<FaceDet | null> {
  try {
    const result = await geminiFlash.generateContent([
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: readImageAsBase64(framePath) } },
    ]);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<FaceDet>;
    if (
      typeof parsed.face_x === "number" &&
      typeof parsed.face_y === "number" &&
      typeof parsed.face_width === "number" &&
      typeof parsed.face_height === "number" &&
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0.4 &&
      parsed.face_width > 50 &&
      parsed.face_height > 50
    ) {
      return {
        face_x: parsed.face_x,
        face_y: parsed.face_y,
        face_width: parsed.face_width,
        face_height: parsed.face_height,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * For each circle segment, sample N frames, detect the speaker's face in each,
 * take the median position, and convert to a PIP circle seed.
 */
export async function locateSpeakerPipPerSegment(
  input: PipLocatorInput
): Promise<Map<string, PipSeed>> {
  const { ffmpegPath, refVideoPath, canvas, segments, tmpDir } = input;
  const N = input.framesPerSegment ?? 3;
  fs.mkdirSync(tmpDir, { recursive: true });
  const seeds = new Map<string, PipSeed>();
  const prompt = buildFacePrompt(canvas);

  for (const seg of segments) {
    const dur = Math.max(0.1, seg.end - seg.start);
    const a = seg.start + dur * 0.2;
    const b = seg.end - dur * 0.2;
    const dets: FaceDet[] = [];

    for (let i = 0; i < N; i++) {
      const t = a + ((b - a) * (i + 0.5)) / N;
      const framePath = path.join(tmpDir, `pip_face_${seg.id}_${i}.jpg`);
      if (!extractFrame(ffmpegPath, refVideoPath, t, canvas, framePath)) continue;
      const det = await detectSpeakerFace(framePath, prompt);
      if (det) dets.push(det);
      try { fs.unlinkSync(framePath); } catch { /* ignore */ }
    }

    if (dets.length === 0) {
      console.warn(`[pip-locator] ${seg.id}: no confident face detection in ${N} frames`);
      continue;
    }

    // Median over detections to absorb per-frame noise
    const medFace = {
      face_x: median(dets.map((d) => d.face_x)),
      face_y: median(dets.map((d) => d.face_y)),
      face_width: median(dets.map((d) => d.face_width)),
      face_height: median(dets.map((d) => d.face_height)),
    };
    const circle = faceToCircle(medFace);
    const avgConf = dets.reduce((s, d) => s + d.confidence, 0) / dets.length;

    // Sanity-check the derived circle: must fit roughly inside canvas.
    if (
      circle.cx < 0 || circle.cx > canvas.width ||
      circle.cy < 0 || circle.cy > canvas.height ||
      circle.radius < canvas.width * 0.08 ||
      circle.radius > canvas.width * 0.4
    ) {
      console.warn(
        `[pip-locator] ${seg.id}: derived circle out of bounds — face median ${JSON.stringify(medFace)} → circle ${JSON.stringify(circle)}`
      );
      continue;
    }

    seeds.set(seg.id, {
      cx: circle.cx,
      cy: circle.cy,
      radius: circle.radius,
      confidence: avgConf,
      reasoning: dets[0].reasoning,
    });
    console.log(
      `[pip-locator] ${seg.id}: ${dets.length}/${N} face detections, ` +
        `median face ${medFace.face_width}x${medFace.face_height} at (${medFace.face_x},${medFace.face_y}) → ` +
        `PIP (${circle.cx},${circle.cy},r=${circle.radius}) conf=${avgConf.toFixed(2)}`
    );
  }

  return seeds;
}
