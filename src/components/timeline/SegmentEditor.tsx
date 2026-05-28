"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { TimelineSegment } from "@/lib/types/timeline";
import type { BRollCatalogEntry } from "@/lib/types/project";
import { Layers, Move, ArrowRightLeft, Eye, EyeOff } from "lucide-react";

interface SegmentEditorProps {
  segment: TimelineSegment;
  index: number;
  brollCatalog: BRollCatalogEntry[];
  onUpdate: (segmentId: string, updates: Partial<TimelineSegment>) => void;
}

const LAYOUTS: { value: TimelineSegment["layout"]; label: string }[] = [
  { value: "full_screen", label: "Full Screen" },
  { value: "pip_overlay", label: "PIP Overlay" },
  { value: "vertical_split", label: "Vertical Split" },
  { value: "side_by_side", label: "Side by Side" },
];

const TRANSITIONS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "slide_left", label: "Slide Left" },
  { value: "slide_right", label: "Slide Right" },
  { value: "slide_up", label: "Slide Up" },
  { value: "zoom", label: "Zoom" },
  { value: "dissolve", label: "Dissolve" },
];

export function SegmentEditor({ segment, index, brollCatalog, onUpdate }: SegmentEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const durSec = ((segment.end_frame - segment.start_frame) / 30).toFixed(1);

  return (
    <div className="border rounded-lg p-2 text-xs space-y-2">
      {/* Header */}
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <Badge variant="outline" className="text-[10px]">{index + 1}</Badge>
        <span className="font-mono text-muted-foreground">{durSec}s</span>
        <Badge variant="secondary" className="text-[9px]">
          {segment.layout.replace("_", " ")}
        </Badge>
        {segment.broll.motion && segment.broll.motion.type !== "static" && (
          <Badge variant="outline" className="text-[9px] gap-0.5">
            <Move className="h-2 w-2" />
            {segment.broll.motion.type.replace("_", " ")}
          </Badge>
        )}
        <span className="ml-auto text-muted-foreground">{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Editor (expanded) */}
      {expanded && (
        <div className="space-y-2 pt-1 border-t">
          {/* Layout picker */}
          <div className="flex items-center gap-2">
            <Layers className="h-3 w-3 text-muted-foreground shrink-0" />
            <Select
              value={segment.layout}
              onValueChange={(val: string) =>
                onUpdate(segment.id, { layout: val as TimelineSegment["layout"] })
              }
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAYOUTS.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Transition picker */}
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-3 w-3 text-muted-foreground shrink-0" />
            <Select
              value={segment.transition_in?.type ?? "none"}
              onValueChange={(val: string) =>
                onUpdate(segment.id, {
                  transition_in: val === "none"
                    ? undefined
                    : { type: val, duration_frames: 8 },
                })
              }
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSITIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value} className="text-xs">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* B-roll swap */}
          {brollCatalog.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground shrink-0">B-Roll:</span>
              <Select
                value={segment.broll.src || "none"}
                onValueChange={(val: string) =>
                  onUpdate(segment.id, {
                    broll: { ...segment.broll, src: val === "none" ? "" : val },
                  })
                }
              >
                <SelectTrigger className="h-7 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">None</SelectItem>
                  {brollCatalog.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      {b.content_summary?.slice(0, 40) ?? b.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Toggle PIP visibility */}
          {segment.aroll && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] gap-1"
              onClick={() =>
                onUpdate(segment.id, { aroll: undefined })
              }
            >
              <EyeOff className="h-3 w-3" /> Hide Speaker PIP
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
