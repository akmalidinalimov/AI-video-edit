"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { BRollCatalogEntry } from "@/lib/types/project";

interface BRollCatalogProps {
  entries: BRollCatalogEntry[];
}

export function BRollCatalog({ entries }: BRollCatalogProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {entries.length} asset{entries.length !== 1 ? "s" : ""} cataloged
      </p>
      {entries.map((entry) => (
        <Card key={entry.id}>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-tight">
                {entry.content_summary.slice(0, 80)}
                {entry.content_summary.length > 80 ? "..." : ""}
              </p>
              <Badge
                variant={entry.quality_score >= 70 ? "default" : "secondary"}
                className="shrink-0 text-xs"
              >
                {entry.quality_score}/100
              </Badge>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-[10px]">
                {entry.type}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {entry.classification}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {entry.best_use.replace("_", " ")}
              </Badge>
            </div>

            {entry.dominant_colors.length > 0 && (
              <div className="flex items-center gap-1">
                {entry.dominant_colors.slice(0, 5).map((color, i) => (
                  <div
                    key={i}
                    className="h-4 w-4 rounded-sm border"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            )}

            {entry.semantic_tags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {entry.semantic_tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {entry.crop_recommendation.notes && (
              <p className="text-[11px] text-amber-600 bg-amber-50 px-2 py-1 rounded">
                {entry.crop_recommendation.notes}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
