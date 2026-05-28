import React from "react";
import { Audio, useCurrentFrame } from "remotion";
import type { SFXEvent } from "@/lib/types/render";

interface SFXLayerProps {
  events: SFXEvent[];
}

/**
 * Maps SFX event types to bundled audio file paths.
 * In production, these would be actual audio files in public/sfx/
 */
const SFX_MAP: Record<string, string> = {
  "whoosh_soft": "/sfx/whoosh-soft.mp3",
  "whoosh_hard": "/sfx/whoosh-hard.mp3",
  "pop": "/sfx/pop.mp3",
  "ding": "/sfx/ding.mp3",
  "click": "/sfx/click.mp3",
  "swoosh": "/sfx/swoosh.mp3",
  "rise": "/sfx/rise.mp3",
};

/**
 * Renders sound effects at specified frames.
 * Each SFX event triggers a short audio clip.
 */
export const SFXLayer: React.FC<SFXLayerProps> = ({ events }) => {
  const frame = useCurrentFrame();

  return (
    <>
      {events.map((event, i) => {
        const sfxPath = SFX_MAP[event.sfxId] ?? SFX_MAP["pop"];
        if (!sfxPath) return null;

        // Only mount audio near its trigger frame
        // (Remotion handles the actual timing)
        const isNearby = Math.abs(frame - event.frame) < 60; // 2 second window
        if (!isNearby) return null;

        return (
          <Audio
            key={`sfx-${i}-${event.frame}`}
            src={sfxPath}
            volume={event.volume}
            startFrom={event.frame}
            endAt={event.frame + 30} // SFX are max 1 second
          />
        );
      })}
    </>
  );
};

/**
 * Generate SFX events from timeline data.
 * Maps transitions, text appearances, and hooks to sound effects.
 */
export function generateSFXEvents(
  segments: { id: string; start_frame: number; transition_in?: { type: string } }[],
  hookFrame?: number
): SFXEvent[] {
  const events: SFXEvent[] = [];

  for (const seg of segments) {
    // Transition sound
    if (seg.transition_in) {
      const sfxId = seg.transition_in.type === "slide_left" || seg.transition_in.type === "slide_right"
        ? "whoosh_soft"
        : seg.transition_in.type === "zoom"
          ? "swoosh"
          : "whoosh_soft";

      events.push({
        type: "transition",
        frame: seg.start_frame,
        sfxId,
        volume: 0.3,
      });
    }
  }

  // Hook sound
  if (hookFrame !== undefined) {
    events.push({
      type: "hook",
      frame: hookFrame,
      sfxId: "ding",
      volume: 0.4,
    });
  }

  return events;
}
