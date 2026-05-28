"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Columns2, ArrowLeftRight, Eye, Film } from "lucide-react";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { TimelineDefinition } from "@/lib/types/timeline";

interface ComparisonViewProps {
  referenceUrl: string;
  styleProfile: StyleProfile;
  timeline: TimelineDefinition;
}

export function ComparisonView({
  referenceUrl,
  styleProfile,
  timeline,
}: ComparisonViewProps) {
  const [mode, setMode] = useState<"side_by_side" | "overlay" | "details">("details");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Columns2 className="h-3.5 w-3.5" />
            Style Comparison
          </CardTitle>
          <div className="flex gap-1">
            <Button
              variant={mode === "details" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 text-[10px]"
              onClick={() => setMode("details")}
            >
              Details
            </Button>
            <Button
              variant={mode === "side_by_side" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 text-[10px]"
              onClick={() => setMode("side_by_side")}
            >
              Split
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {mode === "details" && (
          <StyleComparisonTable
            styleProfile={styleProfile}
            timeline={timeline}
          />
        )}

        {mode === "side_by_side" && (
          <div className="flex gap-2">
            {/* Reference preview */}
            <div className="flex-1 space-y-1">
              <Badge variant="outline" className="text-[9px]">Reference</Badge>
              <div className="w-full aspect-[9/16] bg-black rounded-lg overflow-hidden flex items-center justify-center">
                {referenceUrl ? (
                  <video
                    src={referenceUrl}
                    className="w-full h-full object-cover"
                    controls
                    muted
                  />
                ) : (
                  <Film className="h-6 w-6 text-white/30" />
                )}
              </div>
            </div>

            {/* Generated preview */}
            <div className="flex items-center">
              <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 space-y-1">
              <Badge variant="outline" className="text-[9px]">Generated</Badge>
              <div className="w-full aspect-[9/16] bg-black rounded-lg overflow-hidden flex items-center justify-center">
                <div className="text-center text-white/30 text-[10px] p-2">
                  <Eye className="h-6 w-6 mx-auto mb-1" />
                  Preview in player above
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StyleComparisonTable({
  styleProfile,
  timeline,
}: {
  styleProfile: StyleProfile;
  timeline: TimelineDefinition;
}) {
  const refSegCount = styleProfile.segments.length;
  const genSegCount = timeline.segments.length;

  const refLayouts = [...new Set(styleProfile.segments.map((s) => s.layout))];
  const genLayouts = [...new Set(timeline.segments.map((s) => s.layout))];

  const refTransitions = [...new Set(
    styleProfile.segments.map((s) => s.transition_in).filter(Boolean)
  )];
  const genTransitions = [...new Set(
    timeline.segments.map((s) => s.transition_in?.type).filter(Boolean)
  )];

  const rows = [
    {
      label: "Segments",
      reference: `${refSegCount}`,
      generated: `${genSegCount}`,
      match: Math.abs(refSegCount - genSegCount) <= 2,
    },
    {
      label: "Color Temp",
      reference: styleProfile.color_grade.temperature,
      generated: timeline.color_grade.temperature,
      match: styleProfile.color_grade.temperature === timeline.color_grade.temperature,
    },
    {
      label: "PIP Shape",
      reference: [...new Set(
        styleProfile.segments
          .filter((s) => s.aroll?.shape)
          .map((s) => s.aroll!.shape)
      )].join(", ") || styleProfile.pip_style.shape,
      generated: [...new Set(
        timeline.segments
          .filter((s) => s.aroll?.shape)
          .map((s) => s.aroll!.shape)
      )].join(", ") || "none",
      match: true,
    },
    {
      label: "Layouts",
      reference: refLayouts.join(", "),
      generated: genLayouts.join(", "),
      match: refLayouts.some((l) => genLayouts.includes(l)),
    },
    {
      label: "Transitions",
      reference: refTransitions.length > 0 ? refTransitions.join(", ") : "none",
      generated: genTransitions.length > 0 ? genTransitions.join(", ") : "none",
      match: true,
    },
    {
      label: "Captions",
      reference: styleProfile.segments.some((s) => s.text_overlays?.length) ? "Yes" : "No",
      generated: timeline.captions.lines.length > 0 ? `Yes (${timeline.captions.lines.length} lines)` : "No",
      match: true,
    },
  ];

  return (
    <div className="space-y-1">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[80px_1fr_1fr] gap-2 text-[10px] items-center"
        >
          <span className="text-muted-foreground font-medium">{row.label}</span>
          <Badge variant="outline" className="text-[9px] justify-center">
            {row.reference}
          </Badge>
          <Badge
            variant={row.match ? "secondary" : "destructive"}
            className="text-[9px] justify-center"
          >
            {row.generated}
          </Badge>
        </div>
      ))}
      <div className="grid grid-cols-[80px_1fr_1fr] gap-2 text-[9px] text-muted-foreground pt-1 border-t">
        <span />
        <span className="text-center">Reference</span>
        <span className="text-center">Generated</span>
      </div>
    </div>
  );
}
