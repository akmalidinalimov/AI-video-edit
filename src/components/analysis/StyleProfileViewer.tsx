"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StyleProfile } from "@/lib/types/styleProfile";

interface StyleProfileViewerProps {
  profile: StyleProfile;
}

export function StyleProfileViewer({ profile }: StyleProfileViewerProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Source Video</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Duration</span>
            <span>{profile.source.duration.toFixed(1)}s</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">FPS</span>
            <span>{profile.source.fps}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Resolution</span>
            <span>{profile.source.resolution}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Editing Rhythm</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-1.5 flex-wrap">
            <Badge variant="secondary">{profile.editing_rhythm.pacing} pacing</Badge>
            <Badge variant="secondary">{profile.editing_rhythm.cut_style}</Badge>
            <Badge variant="secondary">{profile.editing_rhythm.total_segments} segments</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Avg segment: {profile.editing_rhythm.avg_segment_duration.toFixed(1)}s
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Color Grade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Brightness</span>
            <span>{(profile.color_grade.brightness * 100).toFixed(0)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Saturation</span>
            <span>{(profile.color_grade.saturation * 100).toFixed(0)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Temperature</span>
            <Badge variant="outline" className="text-xs">{profile.color_grade.temperature}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">PIP Style</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Shape</span>
            <span>{profile.pip_style.shape}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Size</span>
            <span>{profile.pip_style.size || profile.pip_style.typical_size}px</span>
          </div>
          {profile.pip_style.border && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Border</span>
              <span>{profile.pip_style.border.width}px {profile.pip_style.border.color}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Segments ({profile.segments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {profile.segments.map((seg) => (
              <div key={seg.id} className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {seg.start.toFixed(1)}s–{seg.end.toFixed(1)}s
                </Badge>
                <span className="text-muted-foreground truncate">{seg.layout}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
