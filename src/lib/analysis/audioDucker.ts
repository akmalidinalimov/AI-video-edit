import type { AudioTrack } from "@/lib/types/timeline";
import type { VolumeKeyframe } from "@/lib/types/render";

const RAMP_FRAMES = 10;
const SPEECH_VOLUME = 0.25;
const SILENCE_VOLUME = 0.85;

/**
 * Computes a volume envelope for background music that ducks
 * during speech and comes back up during silence.
 */
export function computeDuckingEnvelope(
  voiceTracks: AudioTrack[],
  totalFrames: number
): VolumeKeyframe[] {
  if (voiceTracks.length === 0) {
    return [
      { frame: 0, volume: SILENCE_VOLUME },
      { frame: totalFrames, volume: SILENCE_VOLUME },
    ];
  }

  // Sort voice tracks by start frame
  const sorted = [...voiceTracks].sort((a, b) => a.start_frame - b.start_frame);

  // Merge overlapping voice regions
  const speechRegions: { start: number; end: number }[] = [];
  for (const track of sorted) {
    if (track.type !== "aroll_voice") continue;
    const last = speechRegions[speechRegions.length - 1];
    if (last && track.start_frame <= last.end + RAMP_FRAMES) {
      last.end = Math.max(last.end, track.end_frame);
    } else {
      speechRegions.push({ start: track.start_frame, end: track.end_frame });
    }
  }

  if (speechRegions.length === 0) {
    return [
      { frame: 0, volume: SILENCE_VOLUME },
      { frame: totalFrames, volume: SILENCE_VOLUME },
    ];
  }

  const keyframes: VolumeKeyframe[] = [];

  // Start at silence volume
  const firstSpeech = speechRegions[0];
  if (firstSpeech.start > 0) {
    keyframes.push({ frame: 0, volume: SILENCE_VOLUME });
  }

  for (let i = 0; i < speechRegions.length; i++) {
    const region = speechRegions[i];

    // Ramp down before speech starts
    const rampDownStart = Math.max(0, region.start - RAMP_FRAMES);
    keyframes.push({ frame: rampDownStart, volume: SILENCE_VOLUME });
    keyframes.push({ frame: region.start, volume: SPEECH_VOLUME });

    // Ramp up after speech ends
    const rampUpEnd = Math.min(totalFrames, region.end + RAMP_FRAMES);
    keyframes.push({ frame: region.end, volume: SPEECH_VOLUME });
    keyframes.push({ frame: rampUpEnd, volume: SILENCE_VOLUME });
  }

  // Ensure we end at the total frames
  const lastKf = keyframes[keyframes.length - 1];
  if (lastKf && lastKf.frame < totalFrames) {
    keyframes.push({ frame: totalFrames, volume: SILENCE_VOLUME });
  }

  return keyframes;
}

/**
 * Given a ducking envelope and a frame number, returns the interpolated volume.
 */
export function getVolumeAtFrame(
  envelope: VolumeKeyframe[],
  frame: number
): number {
  if (envelope.length === 0) return 1.0;
  if (frame <= envelope[0].frame) return envelope[0].volume;
  if (frame >= envelope[envelope.length - 1].frame) return envelope[envelope.length - 1].volume;

  for (let i = 0; i < envelope.length - 1; i++) {
    const curr = envelope[i];
    const next = envelope[i + 1];
    if (frame >= curr.frame && frame <= next.frame) {
      const t = (frame - curr.frame) / (next.frame - curr.frame);
      return curr.volume + t * (next.volume - curr.volume);
    }
  }

  return 1.0;
}
