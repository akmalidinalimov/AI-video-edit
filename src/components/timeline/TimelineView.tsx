"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type { TimelineDefinition, TimelineSegment, TransitionPlan, EngagementHook, MissingAssetPrompt } from "@/lib/types/timeline";
import type { MatchResult, BRollCatalogEntry } from "@/lib/types/project";
import type { ContentSegment } from "@/lib/matching/segmenter";
import type { SegmentRenderDescription } from "@/lib/matching/renderDescriptions";
import { Film, Image, Volume2, AlertCircle, Sparkles, Type, Zap, ImageOff, Layers, ArrowRightLeft, Move } from "lucide-react";
import { SegmentEditor } from "./SegmentEditor";

interface TimelineViewProps {
  timeline: TimelineDefinition;
  matches: MatchResult[];
  contentSegments: ContentSegment[];
  transitions: TransitionPlan[];
  hook: EngagementHook | null;
  missingAssetPrompts: MissingAssetPrompt[];
  renderDescriptions: SegmentRenderDescription[];
  optimizerChanges: { segmentId: string; from: string; to: string; reason: string }[];
  stats: {
    totalSegments: number;
    matchedSegments: number;
    unmatchedSegments: number;
    totalDuration: number;
    avgMatchScore: number;
    captionLines: number;
    hasHook: boolean;
    missingAssets: number;
  };
  brollCatalog?: BRollCatalogEntry[];
  onSegmentUpdate?: (segmentId: string, updates: Record<string, unknown>) => void;
}

const layoutColors: Record<string, string> = {
  full_screen: "bg-blue-500",
  pip_overlay: "bg-purple-500",
  vertical_split: "bg-green-500",
  side_by_side: "bg-orange-500",
};

export function TimelineView({
  timeline, matches, contentSegments, transitions,
  hook, missingAssetPrompts, renderDescriptions, optimizerChanges, stats,
  brollCatalog = [], onSegmentUpdate,
}: TimelineViewProps) {
  const pxPerSecond = 80;
  const totalWidth = timeline.duration * pxPerSecond;

  return (
    <div className="space-y-3">
      {/* Stats bar */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Badge variant="outline">{stats.totalSegments} segments</Badge>
        <Badge className="bg-green-600">{stats.matchedSegments} matched</Badge>
        {stats.unmatchedSegments > 0 && (
          <Badge variant="destructive">{stats.unmatchedSegments} missing</Badge>
        )}
        <Badge variant="secondary" className="gap-1">
          <Type className="h-2.5 w-2.5" />{stats.captionLines} captions
        </Badge>
        {stats.hasHook && (
          <Badge variant="secondary" className="gap-1">
            <Zap className="h-2.5 w-2.5" />Hook
          </Badge>
        )}
        <span className="text-muted-foreground ml-auto">
          {timeline.duration.toFixed(1)}s · Score: {(stats.avgMatchScore * 100).toFixed(0)}%
        </span>
      </div>

      {/* Engagement hook */}
      {hook && (
        <Card className="border-yellow-200 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/30">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
              <span className="font-medium text-yellow-800 dark:text-yellow-200">Hook:</span>
              <span className="font-semibold">&ldquo;{hook.text}&rdquo;</span>
              <Badge variant="outline" className="ml-auto text-[9px]">
                {hook.type} · {hook.animation.type}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timeline tracks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Timeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="w-full">
            <div className="p-4" style={{ width: Math.max(totalWidth + 40, 400) }}>
              {/* Time ruler */}
              <div className="relative h-5 mb-1 border-b border-muted">
                {Array.from({ length: Math.ceil(timeline.duration) + 1 }, (_, i) => (
                  <div
                    key={i}
                    className="absolute text-[9px] text-muted-foreground"
                    style={{ left: i * pxPerSecond }}
                  >
                    {i}s
                  </div>
                ))}
              </div>

              {/* B-Roll track */}
              <TrackLabel label="B-Roll" />
              <div className="relative h-10 mb-1">
                {contentSegments.map((seg) => {
                  const match = matches.find((m) => m.segment_id === seg.id);
                  const tSeg = timeline.segments.find((t) => t.id === seg.id);
                  const hasMatch = match && match.selected_broll !== "NONE";
                  const motionType = tSeg?.broll?.motion?.type;
                  const left = seg.globalStart * pxPerSecond;
                  const width = Math.max(seg.duration * pxPerSecond - 2, 4);

                  return (
                    <div
                      key={seg.id}
                      className={`absolute top-0 h-10 rounded text-[9px] flex items-center justify-center overflow-hidden border ${
                        hasMatch
                          ? "bg-emerald-100 border-emerald-300 dark:bg-emerald-950 dark:border-emerald-700"
                          : "bg-red-50 border-red-200 border-dashed dark:bg-red-950 dark:border-red-800"
                      }`}
                      style={{ left, width }}
                      title={`${match?.match_reason ?? "No match"}${motionType ? `\nMotion: ${motionType}` : ""}`}
                    >
                      {hasMatch ? (
                        <span className="truncate px-1 flex items-center gap-0.5">
                          {motionType && motionType !== "static" && (
                            <Move className="h-2.5 w-2.5 shrink-0 text-emerald-600" />
                          )}
                          {!motionType || motionType === "static" ? (
                            match.match_score >= 0.7 ? (
                              <Film className="h-2.5 w-2.5 shrink-0" />
                            ) : (
                              <Image className="h-2.5 w-2.5 shrink-0" />
                            )
                          ) : null}
                          {width > 40 && <span>{(match.match_score * 100).toFixed(0)}%</span>}
                        </span>
                      ) : (
                        <AlertCircle className="h-3 w-3 text-red-400" />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* A-Roll / speech track */}
              <TrackLabel label="A-Roll" />
              <div className="relative h-10 mb-1">
                {contentSegments.map((seg) => {
                  const tSeg = timeline.segments.find((t) => t.id === seg.id);
                  const layout = tSeg?.layout ?? "full_screen";
                  const trans = transitions.find((t) => t.segment_id === seg.id);
                  const left = seg.globalStart * pxPerSecond;
                  const width = Math.max(seg.duration * pxPerSecond - 2, 4);

                  return (
                    <div
                      key={seg.id}
                      className="absolute top-0 h-10 rounded border border-slate-300 dark:border-slate-600 overflow-hidden flex items-center"
                      style={{ left, width }}
                      title={`${seg.text}\n\nTransition: ${trans?.transition_in?.type ?? "none"} — ${trans?.reasoning ?? ""}`}
                    >
                      <div className={`h-full w-1 shrink-0 ${layoutColors[layout] ?? "bg-gray-400"}`} />
                      {width > 50 && (
                        <span className="text-[9px] truncate px-1 text-muted-foreground">
                          {seg.text.slice(0, 30)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Caption track */}
              <TrackLabel label="Captions" />
              <div className="relative h-6 mb-1">
                {timeline.captions.lines.map((line, i) => {
                  const left = (line.start_frame / timeline.fps) * pxPerSecond;
                  const width = Math.max(
                    ((line.end_frame - line.start_frame) / timeline.fps) * pxPerSecond - 1,
                    3
                  );
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-6 rounded bg-violet-100 border border-violet-300 dark:bg-violet-950 dark:border-violet-700 flex items-center px-0.5 overflow-hidden"
                      style={{ left, width }}
                      title={line.text}
                    >
                      {width > 20 && (
                        <span className="text-[8px] truncate text-violet-700 dark:text-violet-300">
                          {line.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Audio track */}
              <TrackLabel label="Audio" />
              <div className="relative h-6">
                {timeline.audio.map((track, i) => {
                  const left = (track.start_frame / timeline.fps) * pxPerSecond;
                  const width = Math.max(
                    ((track.end_frame - track.start_frame) / timeline.fps) * pxPerSecond - 2,
                    4
                  );
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-6 rounded bg-blue-100 border border-blue-300 dark:bg-blue-950 dark:border-blue-700 flex items-center px-1"
                      style={{ left, width }}
                    >
                      <Volume2 className="h-2.5 w-2.5 text-blue-500 shrink-0" />
                      {width > 30 && (
                        <span className="text-[9px] text-blue-600 ml-0.5">{track.volume.toFixed(1)}x</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Missing asset prompts */}
      {missingAssetPrompts.length > 0 && (
        <Card className="border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <ImageOff className="h-3.5 w-3.5 text-red-500" />
              Missing Assets — AI Generation Prompts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {missingAssetPrompts.map((asset) => (
              <div key={asset.segment_id} className="text-xs space-y-1">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[9px]">{asset.segment_id}</Badge>
                  <Badge variant="secondary" className="text-[9px]">{asset.suggested_type}</Badge>
                </div>
                <p className="text-muted-foreground italic">&ldquo;{asset.speech_text.slice(0, 80)}&rdquo;</p>
                <p className="font-medium">{asset.imagen_prompt}</p>
                <p className="text-muted-foreground">{asset.style_guidance}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Optimizer changes */}
      {optimizerChanges.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <ArrowRightLeft className="h-3.5 w-3.5 text-amber-600" />
              Match Optimizer — {optimizerChanges.length} swap{optimizerChanges.length > 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {optimizerChanges.map((change, i) => (
              <div key={i} className="text-xs flex items-center gap-1.5">
                <Badge variant="outline" className="text-[9px]">{change.segmentId}</Badge>
                <span className="text-muted-foreground">{change.reason}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Render descriptions */}
      {renderDescriptions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5" />
              Render Descriptions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {renderDescriptions.map((rd) => (
              <div key={rd.segmentId} className="text-xs border-b border-muted pb-2 last:border-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Badge variant="outline" className="text-[9px]">{rd.segmentId}</Badge>
                </div>
                <p className="text-muted-foreground line-clamp-2">{rd.description}</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {rd.layers.map((layer, j) => (
                    <Badge key={j} variant="secondary" className="text-[8px]">{layer}</Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Segment details + editor */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Segment Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {contentSegments.map((seg, i) => {
              const match = matches.find((m) => m.segment_id === seg.id);
              const tSeg = timeline.segments.find((t) => t.id === seg.id);
              const trans = transitions.find((t) => t.segment_id === seg.id);
              const hasMatch = match && match.selected_broll !== "NONE";

              return (
                <div
                  key={seg.id}
                  className="border-b border-muted pb-2 last:border-0 space-y-1.5"
                >
                  <div className="flex items-start gap-2 text-xs">
                    <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">
                      {i + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="font-mono text-muted-foreground">
                          {seg.globalStart.toFixed(1)}–{seg.globalEnd.toFixed(1)}s
                        </span>
                        <Badge
                          variant="secondary"
                          className={`text-[9px] ${layoutColors[tSeg?.layout ?? ""] ? "text-white " + layoutColors[tSeg?.layout ?? ""] : ""}`}
                        >
                          {tSeg?.layout?.replace("_", " ") ?? "full"}
                        </Badge>
                        {trans?.transition_in && (
                          <Badge variant="outline" className="text-[9px]">
                            {trans.transition_in.type}
                          </Badge>
                        )}
                        {tSeg?.broll?.motion && tSeg.broll.motion.type !== "static" && (
                          <Badge variant="outline" className="text-[9px] gap-0.5">
                            <Move className="h-2 w-2" />
                            {tSeg.broll.motion.type.replace("_", " ")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground line-clamp-1">{seg.text}</p>
                      {match && (
                        <div className="mt-1 flex items-center gap-1.5">
                          {hasMatch ? (
                            <>
                              <Badge className="bg-green-600 text-[9px]">
                                {(match.match_score * 100).toFixed(0)}%
                              </Badge>
                              <span className="text-muted-foreground truncate">{match.match_reason}</span>
                            </>
                          ) : (
                            <span className="text-red-500">{match.match_reason}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Inline segment editor */}
                  {tSeg && onSegmentUpdate && (
                    <SegmentEditor
                      segment={tSeg}
                      index={i}
                      brollCatalog={brollCatalog}
                      onUpdate={onSegmentUpdate}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TrackLabel({ label }: { label: string }) {
  return (
    <div className="text-[9px] text-muted-foreground mb-0.5 font-medium">{label}</div>
  );
}
