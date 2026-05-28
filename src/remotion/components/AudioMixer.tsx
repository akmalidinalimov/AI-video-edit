import React, { useCallback } from "react";
import { Audio, Sequence, useCurrentFrame, interpolate } from "remotion";
import type { AudioTrack } from "@/lib/types/timeline";
import type { VolumeKeyframe } from "@/lib/types/render";
import { getVolumeAtFrame } from "@/lib/analysis/audioDucker";

interface AudioMixerProps {
  tracks: AudioTrack[];
  /** Ducking envelope for background music */
  duckingEnvelope?: VolumeKeyframe[];
}

export const AudioMixer: React.FC<AudioMixerProps> = ({
  tracks,
  duckingEnvelope,
}) => {
  return (
    <>
      {tracks.map((track, i) => {
        const durationFrames = track.end_frame - track.start_frame;
        if (durationFrames <= 0) return null;

        return (
          <Sequence
            key={`audio-${track.type}-${i}`}
            from={track.start_frame}
            durationInFrames={durationFrames}
            name={`Audio: ${track.type} ${i}`}
          >
            <AudioTrackRenderer
              track={track}
              duckingEnvelope={
                track.type === "background_music" ? duckingEnvelope : undefined
              }
            />
          </Sequence>
        );
      })}
    </>
  );
};

interface AudioTrackRendererProps {
  track: AudioTrack;
  duckingEnvelope?: VolumeKeyframe[];
}

const AudioTrackRenderer: React.FC<AudioTrackRendererProps> = ({
  track,
  duckingEnvelope,
}) => {
  // useCurrentFrame() is now RELATIVE to the Sequence (starts at 0)
  const frame = useCurrentFrame();
  const durationFrames = track.end_frame - track.start_frame;

  const volumeCallback = useCallback(
    (f: number) => {
      let vol = track.volume;

      // Apply fade in (f is relative to sequence start, i.e. 0-based)
      if (track.fade_in) {
        const fadeFrames = track.fade_in * 30;
        if (f < fadeFrames) {
          vol *= interpolate(f, [0, fadeFrames], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
        }
      }

      // Apply fade out
      if (track.fade_out) {
        const fadeFrames = track.fade_out * 30;
        const fadeStart = durationFrames - fadeFrames;
        if (f > fadeStart) {
          vol *= interpolate(f, [fadeStart, durationFrames], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
        }
      }

      // Apply ducking envelope for BGM (needs global frame)
      if (duckingEnvelope) {
        const globalFrame = track.start_frame + f;
        vol *= getVolumeAtFrame(duckingEnvelope, globalFrame);
      }

      return Math.max(0, Math.min(2, vol));
    },
    [track, durationFrames, duckingEnvelope]
  );

  // sourceStartFrom is the frame in the SOURCE file to start from
  // This correctly syncs each segment to its portion of the A-roll
  const sourceStart = track.sourceStartFrom ?? track.start_frame;

  return (
    <Audio
      src={track.src}
      volume={volumeCallback}
      startFrom={sourceStart}
    />
  );
};
