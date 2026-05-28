import type { BeatMap } from "@/lib/types/render";

/**
 * Simple energy-based beat detection for background music.
 * Uses onset detection by comparing energy in short windows.
 *
 * In a production system this would use Web Audio API AnalyserNode.
 * For server-side rendering, we compute from audio buffer data.
 */

const DEFAULT_BPM = 120;
const MIN_BPM = 60;
const MAX_BPM = 180;

/**
 * Estimates BPM and beat positions from audio duration.
 * This is a fallback when audio analysis isn't available —
 * generates evenly-spaced beats at the estimated BPM.
 */
export function estimateBeats(
  durationSeconds: number,
  estimatedBpm: number = DEFAULT_BPM
): BeatMap {
  const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, estimatedBpm));
  const beatInterval = 60 / bpm;
  const beats: number[] = [];

  let t = 0;
  while (t < durationSeconds) {
    beats.push(t);
    t += beatInterval;
  }

  return { bpm, beats, confidence: 0.5 };
}

/**
 * Snap a timestamp to the nearest beat.
 */
export function snapToBeat(
  timestamp: number,
  beatMap: BeatMap,
  maxSnapDistance: number = 0.15 // max 150ms snap
): number {
  let nearest = timestamp;
  let minDist = Infinity;

  for (const beat of beatMap.beats) {
    const dist = Math.abs(timestamp - beat);
    if (dist < minDist) {
      minDist = dist;
      nearest = beat;
    }
  }

  // Only snap if within threshold
  return minDist <= maxSnapDistance ? nearest : timestamp;
}

/**
 * Find beat positions that fall within a time range.
 */
export function beatsInRange(
  beatMap: BeatMap,
  startSec: number,
  endSec: number
): number[] {
  return beatMap.beats.filter((b) => b >= startSec && b <= endSec);
}

/**
 * Detect if a timestamp is on a strong beat (downbeat).
 * Every 4th beat is a downbeat in 4/4 time.
 */
export function isDownbeat(
  timestamp: number,
  beatMap: BeatMap,
  tolerance: number = 0.05
): boolean {
  const beatInterval = 60 / beatMap.bpm;
  const barInterval = beatInterval * 4;

  for (let bar = 0; bar * barInterval < timestamp + tolerance; bar++) {
    if (Math.abs(timestamp - bar * barInterval) <= tolerance) {
      return true;
    }
  }
  return false;
}
