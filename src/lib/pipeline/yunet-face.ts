/**
 * yunet-face.ts — run the proven YuNet DNN face detector (scripts/python) on an
 * A-roll video to get an accurate, consistent face box (median over N frames).
 * This is the face data `calculateSquareCrop` needs to crop the 1:1 face-safe
 * square per docs/cropping-rules.md — replacing the demo's geometric center-crop.
 *
 * Requires the venv set up at scripts/python/.venv (opencv + the YuNet model).
 */
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

export interface YuNetFace {
  /** face-box center X as a fraction of source width (0..1) */
  centerX: number;
  /** face-box center Y as a fraction of source height (0..1) */
  centerY: number;
  /** face-box height as a fraction of source height (0..1) */
  height: number;
  srcW: number;
  srcH: number;
  detector: "yunet";
  samplesUsed: number;
}

const VENV_PY = path.join(process.cwd(), "scripts", "python", ".venv", "Scripts", "python.exe");
const SCRIPT = path.join(process.cwd(), "scripts", "python", "detect_face_yunet.py");
const SCRIPT_GROUP = path.join(process.cwd(), "scripts", "python", "detect_aroll_group.py");

/** Multi-speaker GROUP box (bounding box of ALL faces, median over frames) so the
 *  crop can frame everyone, not just the largest face. */
export interface ArollGroup {
  /** group centroid x / y (fractions of source) */
  centerX: number;
  centerY: number;
  /** group bounding-box width / height (fractions of source) */
  width: number;
  height: number;
  /** tallest single-face height (fraction) — single-person sizing fallback */
  faceHeight: number;
  srcW: number;
  srcH: number;
  nFaces: number;
}

/** Detect the A-roll speaker GROUP (all faces) via YuNet. Null on failure. */
export function detectArollGroup(videoPath: string, samples = 15): ArollGroup | null {
  if (!fs.existsSync(VENV_PY) || !fs.existsSync(SCRIPT_GROUP)) {
    console.error("[yunet-face] venv or group script missing — run Phase A setup");
    return null;
  }
  const out = path.join(os.tmpdir(), `arollgroup_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync(VENV_PY, [SCRIPT_GROUP, videoPath, out, "--samples", String(samples)], { stdio: "pipe", timeout: 120_000 });
    const j = JSON.parse(fs.readFileSync(out, "utf-8")) as {
      found: boolean; srcWidth: number; srcHeight: number;
      centerX: number; centerY: number; width: number; height: number; faceHeight: number; nFaces: number;
    };
    if (!j.found) return null;
    return {
      centerX: j.centerX, centerY: j.centerY, width: j.width, height: j.height,
      faceHeight: j.faceHeight, srcW: j.srcWidth, srcH: j.srcHeight, nFaces: j.nFaces,
    };
  } catch (e) {
    console.error("[yunet-face] group detection failed:", (e as Error).message);
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
}

/**
 * Detect the speaker's face in `videoPath` via YuNet. Returns the median face
 * box (fractions of source) + source dims, or null if detection/setup fails
 * (callers should fall back gracefully — never crash the render).
 */
export function detectFaceYuNet(videoPath: string, samples = 15): YuNetFace | null {
  if (!fs.existsSync(VENV_PY) || !fs.existsSync(SCRIPT)) {
    console.error("[yunet-face] venv or script missing — run Phase A setup");
    return null;
  }
  const out = path.join(os.tmpdir(), `yunet_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync(VENV_PY, [SCRIPT, videoPath, out, "--samples", String(samples)], {
      stdio: "pipe",
      timeout: 120_000,
    });
    const j = JSON.parse(fs.readFileSync(out, "utf-8")) as {
      median: { centerX: number; centerY: number; height: number };
      srcWidth: number;
      srcHeight: number;
      samplesUsed: number;
    };
    return {
      centerX: j.median.centerX,
      centerY: j.median.centerY,
      height: j.median.height,
      srcW: j.srcWidth,
      srcH: j.srcHeight,
      detector: "yunet",
      samplesUsed: j.samplesUsed,
    };
  } catch (e) {
    console.error("[yunet-face] detection failed:", (e as Error).message);
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
}
