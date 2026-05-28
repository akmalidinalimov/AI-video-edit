"use client";

import { useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { StyleCloneVideo } from "@/remotion/compositions/StyleCloneVideo";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { RenderConfig } from "@/lib/types/render";
import { DEFAULT_RENDER_CONFIG } from "@/lib/types/render";
import { VDIM } from "@/remotion/utils/vdim";
import { Film, Play, Pause, SkipBack, Maximize2, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PreviewCanvasProps {
  hasContent: boolean;
  timeline?: TimelineDefinition | null;
  renderConfig?: Partial<RenderConfig>;
}

export function PreviewCanvas({ hasContent, timeline, renderConfig }: PreviewCanvasProps) {
  const [isMuted, setIsMuted] = useState(false);

  const config = useMemo<RenderConfig>(
    () => ({ ...DEFAULT_RENDER_CONFIG, ...renderConfig }),
    [renderConfig]
  );

  if (!hasContent || !timeline) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-muted/30 rounded-lg">
        <div className="flex flex-col items-center gap-4 text-center p-8">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Video Preview</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Upload a reference video and your footage, then generate an edit to preview
            </p>
          </div>
          <div className="w-[216px] h-[384px] bg-muted rounded-lg border-2 border-dashed border-muted-foreground/20 flex items-center justify-center">
            <span className="text-xs text-muted-foreground">9:16</span>
          </div>
        </div>
      </div>
    );
  }

  const totalFrames = Math.round(timeline.duration * timeline.fps);
  const inputProps = { timeline, renderConfig: config };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      {/* Player */}
      <div className="relative rounded-lg overflow-hidden shadow-2xl border border-border">
        <Player
          component={StyleCloneVideo as unknown as React.ComponentType<Record<string, unknown>>}
          inputProps={inputProps as unknown as Record<string, unknown>}
          durationInFrames={Math.max(totalFrames, 1)}
          compositionWidth={VDIM.WIDTH}
          compositionHeight={VDIM.HEIGHT}
          fps={VDIM.FPS}
          style={{
            width: 270,
            height: 480,
          }}
          controls
          autoPlay={false}
          loop
          showVolumeControls
          clickToPlay
          acknowledgeRemotionLicense
        />
      </div>

      {/* Info bar */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{timeline.duration.toFixed(1)}s</span>
        <span>·</span>
        <span>{VDIM.WIDTH}x{VDIM.HEIGHT}</span>
        <span>·</span>
        <span>{VDIM.FPS}fps</span>
        <span>·</span>
        <span>{timeline.segments.length} segments</span>
      </div>
    </div>
  );
}
