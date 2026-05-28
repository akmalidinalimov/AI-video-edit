"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ARollAnalysis, UsableSegment } from "@/lib/types/project";
import { Volume2, AlertTriangle } from "lucide-react";

interface TranscriptionViewProps {
  analysis: ARollAnalysis;
  usableSegments?: UsableSegment[];
}

const audioLevelColors: Record<string, string> = {
  good: "text-green-600",
  fair: "text-yellow-600",
  poor: "text-red-600",
};

const noiseColors: Record<string, string> = {
  none: "text-green-600",
  low: "text-green-600",
  moderate: "text-yellow-600",
  high: "text-red-600",
};

export function TranscriptionView({ analysis, usableSegments }: TranscriptionViewProps) {
  const silenceTotal = analysis.silence_regions?.reduce((sum, r) => sum + r.duration, 0) ?? 0;
  const audioQ = analysis.audio_quality;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Content Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type</span>
            <Badge variant="secondary">{analysis.content_type.replace("_", " ")}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Duration</span>
            <span>{analysis.duration.toFixed(1)}s</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Language</span>
            <Badge variant="outline">{analysis.language.toUpperCase()}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Speech ratio</span>
            <span>{((analysis.speech_ratio ?? 1) * 100).toFixed(0)}%</span>
          </div>
          {silenceTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Removable silence</span>
              <span className="text-orange-500 font-medium">{silenceTotal.toFixed(1)}s</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audio Quality */}
      {audioQ && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Volume2 className="h-3.5 w-3.5" />
              Audio Quality
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Level</span>
              <span className={audioLevelColors[audioQ.overall_level] ?? ""}>
                {audioQ.overall_level}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Background noise</span>
              <span className={noiseColors[audioQ.background_noise] ?? ""}>
                {audioQ.background_noise}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Volume</span>
              <span>{audioQ.volume_consistency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Loudness</span>
              <span className="font-mono">{audioQ.estimated_db}dB</span>
            </div>
            {audioQ.issues.length > 0 && (
              <div className="mt-2 space-y-1">
                {audioQ.issues.map((issue, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-yellow-600">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    <span>{issue}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {analysis.clip_summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Clip Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">{analysis.clip_summary}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Transcription</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {analysis.transcription.sentences.map((sentence, i) => (
              <div key={i} className="text-xs">
                <div className="flex gap-2">
                  <span className="text-muted-foreground shrink-0 w-14 text-right">
                    {sentence.start.toFixed(1)}s
                  </span>
                  <p className="flex-1">{sentence.text}</p>
                </div>
                {sentence.semantic_tags && sentence.semantic_tags.length > 0 && (
                  <div className="ml-16 mt-0.5 flex gap-1 flex-wrap">
                    {sentence.semantic_tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[9px] px-1 py-0 text-blue-600 border-blue-200">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Usable segments after trimming */}
      {usableSegments && usableSegments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Clean Timeline
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({usableSegments.length} segments)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {usableSegments.map((seg, i) => (
                <div key={i} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground shrink-0">
                      {seg.start.toFixed(1)}–{seg.end.toFixed(1)}s
                    </span>
                    <span className="text-green-600 font-mono shrink-0">
                      {seg.duration.toFixed(1)}s
                    </span>
                  </div>
                  {seg.text && (
                    <p className="text-muted-foreground ml-0 mt-0.5 line-clamp-2">{seg.text}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis.silence_regions && analysis.silence_regions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Silence Regions
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({analysis.silence_regions.length})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {analysis.silence_regions.map((region, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <Badge
                    variant="outline"
                    className={
                      region.type === "silence"
                        ? "text-[10px] border-orange-300 text-orange-600"
                        : region.type === "filler"
                          ? "text-[10px] border-yellow-300 text-yellow-600"
                          : "text-[10px] border-slate-300 text-slate-500"
                    }
                  >
                    {region.type}
                  </Badge>
                  <span className="text-muted-foreground">
                    {region.start.toFixed(1)}s – {region.end.toFixed(1)}s
                  </span>
                  <span className="ml-auto font-mono text-muted-foreground">
                    {region.duration.toFixed(1)}s
                  </span>
                  {region.duration > 0.8 && (
                    <Badge variant="destructive" className="text-[9px] px-1 py-0">cut</Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis.edit_points.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Edit Points</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {analysis.edit_points.map((point, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="text-[10px]">
                    {point.timestamp.toFixed(1)}s
                  </Badge>
                  <span className="text-muted-foreground">{point.type.replace("_", " ")}</span>
                  <span className="ml-auto text-muted-foreground">
                    {(point.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis.emotional_arc.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Emotional Arc</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-1 flex-wrap">
              {analysis.emotional_arc.map((arc, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {arc.mood} ({arc.start.toFixed(0)}–{arc.end.toFixed(0)}s)
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
