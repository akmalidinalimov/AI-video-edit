"use client";

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Download, Film, Loader2, Square, Monitor, Image } from "lucide-react";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { ExportJob } from "@/lib/types/editCommand";
import type { ExportFormat, ThumbnailCandidate } from "@/lib/types/render";
import type { VisualBlueprint } from "@/lib/types/blueprint";

interface ExportPanelProps {
  timeline: TimelineDefinition;
  blueprint?: VisualBlueprint | null;
}

export function ExportPanel({ timeline, blueprint }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>("9:16");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [thumbnails, setThumbnails] = useState<ThumbnailCandidate[]>([]);
  const [loadingThumbnails, setLoadingThumbnails] = useState(false);

  const startRender = useCallback(async () => {
    const jobId = `export_${Date.now()}`;
    setJob({
      id: jobId,
      status: "preparing",
      format,
      progress: 0,
      startedAt: new Date(),
    });

    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeline,
          config: { format },
          ...(blueprint ? { blueprint } : {}),
        }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              setJob((prev) =>
                prev
                  ? {
                      ...prev,
                      status: data.stage,
                      progress: data.progress,
                      framesRendered: data.framesRendered,
                      totalFrames: data.totalFrames,
                      outputUrl: data.outputUrl,
                      fileSize: data.fileSize,
                      error: data.error,
                    }
                  : prev
              );
            } catch {}
          }
        }
      }
    } catch (err) {
      setJob((prev) =>
        prev
          ? { ...prev, status: "error", error: err instanceof Error ? err.message : "Render failed" }
          : prev
      );
    }
  }, [timeline, format]);

  const fetchThumbnails = useCallback(async () => {
    setLoadingThumbnails(true);
    try {
      const res = await fetch("/api/render/thumbnail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline }),
      });
      const data = await res.json();
      setThumbnails(data.candidates ?? []);
    } catch {
      console.error("Thumbnail fetch failed");
    } finally {
      setLoadingThumbnails(false);
    }
  }, [timeline]);

  const formatIcons: Record<ExportFormat, React.ReactNode> = {
    "9:16": <Film className="h-3.5 w-3.5" />,
    "1:1": <Square className="h-3.5 w-3.5" />,
    "16:9": <Monitor className="h-3.5 w-3.5" />,
  };

  const isRendering = job && ["preparing", "rendering", "encoding"].includes(job.status);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Export Video
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Format selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Format:</span>
          <Select value={format} onValueChange={(v: string) => setFormat(v as ExportFormat)}>
            <SelectTrigger className="h-8 text-xs w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9:16" className="text-xs">9:16 Vertical</SelectItem>
              <SelectItem value="1:1" className="text-xs">1:1 Square</SelectItem>
              <SelectItem value="16:9" className="text-xs">16:9 Landscape</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {timeline.duration.toFixed(1)}s · {Math.round(timeline.duration * timeline.fps)} frames
          </span>
        </div>

        {/* Render mode indicator */}
        {blueprint ? (
          <div className="flex items-center gap-1.5 text-[10px] text-green-600 bg-green-50 dark:bg-green-950/30 px-2 py-1 rounded-md">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            V2 Blueprint render ({blueprint.reference.segments.length} segments, {blueprint.confidence.overall * 100}% confidence)
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 rounded-md">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            V1 Legacy render (single-pass, no layout awareness)
          </div>
        )}

        {/* Render button + progress */}
        <div className="space-y-2">
          <Button
            size="sm"
            className="w-full gap-1.5"
            onClick={startRender}
            disabled={!!isRendering}
          >
            {isRendering ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {job.status === "preparing" ? "Preparing..." : `Rendering ${Math.round(job.progress * 100)}%`}
              </>
            ) : (
              <>
                {formatIcons[format]}
                Export {format} {blueprint ? "(V2)" : ""}
              </>
            )}
          </Button>

          {/* Progress bar */}
          {job && isRendering && (
            <div className="space-y-1">
              <div className="w-full bg-muted rounded-full h-1.5">
                <div
                  className="bg-primary h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{job.status}</span>
                {job.framesRendered && job.totalFrames && (
                  <span>{job.framesRendered}/{job.totalFrames} frames</span>
                )}
              </div>
            </div>
          )}

          {/* Complete */}
          {job?.status === "complete" && (
            <div className="text-xs space-y-1">
              {job.error ? (
                <p className="text-amber-600">{job.error}</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-green-600">
                    <Badge className="bg-green-600 text-[9px]">Done</Badge>
                    <span>Video exported successfully</span>
                  </div>
                  {job.outputUrl && (
                    <a
                      href={job.outputUrl}
                      download
                      className="inline-flex items-center justify-center gap-1.5 w-full h-7 rounded-md border border-input bg-background px-2.5 text-xs font-medium hover:bg-muted transition-colors"
                    >
                      <Download className="h-3 w-3" /> Download MP4
                    </a>
                  )}
                </>
              )}
            </div>
          )}

          {/* Error */}
          {job?.status === "error" && (
            <p className="text-xs text-red-500">{job.error}</p>
          )}
        </div>

        {/* Thumbnail candidates */}
        <div className="border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={fetchThumbnails}
            disabled={loadingThumbnails}
          >
            {loadingThumbnails ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Image className="h-3 w-3" />
            )}
            Generate Thumbnails
          </Button>
          {thumbnails.length > 0 && (
            <div className="mt-2 space-y-1">
              {thumbnails.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <Badge variant="outline" className="text-[9px]">#{i + 1}</Badge>
                  <span className="text-muted-foreground">Frame {t.frame}</span>
                  <Badge variant="secondary" className="text-[9px]">{t.score}pts</Badge>
                  <span className="text-muted-foreground truncate">{t.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
