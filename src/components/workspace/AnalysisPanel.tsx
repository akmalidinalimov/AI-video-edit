"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StyleProfileViewer } from "@/components/analysis/StyleProfileViewer";
import { TranscriptionView } from "@/components/analysis/TranscriptionView";
import { BRollCatalog } from "@/components/analysis/BRollCatalog";
import { ReferenceProgress } from "@/components/analysis/ReferenceProgress";
import { computeTotalTrimmedDuration } from "@/lib/analysis/silenceTrimmer";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { ARollClipAnalysis, ARollSequence, SpeakerConsistency, BRollCatalogEntry } from "@/lib/types/project";
import type { AnalysisStatus } from "@/lib/types/project";
import type { AnalysisStep } from "@/lib/hooks/useStreamingAnalysis";
import { Loader2, ArrowDown, AlertTriangle, CheckCircle, User } from "lucide-react";

interface AnalysisPanelProps {
  styleProfile: StyleProfile | null;
  arollAnalyses: ARollClipAnalysis[];
  arollSequence: ARollSequence | null;
  speakerCheck: SpeakerConsistency | null;
  brollCatalog: BRollCatalogEntry[];
  status: {
    reference: AnalysisStatus;
    aroll: AnalysisStatus;
    broll: AnalysisStatus;
  };
  referenceProgress?: {
    step: AnalysisStep;
    message: string;
  };
}

function StatusBadge({ status }: { status: AnalysisStatus }) {
  if (status === "idle") return null;
  if (status === "analyzing")
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
      </Badge>
    );
  if (status === "complete") return <Badge className="bg-green-600">Done</Badge>;
  return <Badge variant="destructive">Error</Badge>;
}

export function AnalysisPanel({
  styleProfile,
  arollAnalyses,
  arollSequence,
  speakerCheck,
  brollCatalog,
  status,
  referenceProgress,
}: AnalysisPanelProps) {
  const trimStats = arollAnalyses.length > 0
    ? computeTotalTrimmedDuration(arollAnalyses)
    : null;

  return (
    <Tabs defaultValue="style" className="h-full flex flex-col">
      <TabsList className="mx-4 mt-2">
        <TabsTrigger value="style" className="text-xs gap-1">
          Style
          <StatusBadge status={status.reference} />
        </TabsTrigger>
        <TabsTrigger value="aroll" className="text-xs gap-1">
          A-Roll
          {arollAnalyses.length > 0 && (
            <span className="text-[10px] text-muted-foreground ml-0.5">
              ({arollAnalyses.length})
            </span>
          )}
          <StatusBadge status={status.aroll} />
        </TabsTrigger>
        <TabsTrigger value="broll" className="text-xs gap-1">
          B-Roll
          <StatusBadge status={status.broll} />
        </TabsTrigger>
      </TabsList>
      <ScrollArea className="flex-1">
        <TabsContent value="style" className="p-4 mt-0">
          {styleProfile ? (
            <StyleProfileViewer profile={styleProfile} />
          ) : status.reference === "analyzing" && referenceProgress ? (
            <ReferenceProgress step={referenceProgress.step} message={referenceProgress.message} />
          ) : status.reference === "analyzing" ? (
            <AnalyzingState label="Analyzing reference video..." />
          ) : (
            <EmptyState label="Upload a reference video to see style analysis" />
          )}
        </TabsContent>
        <TabsContent value="aroll" className="p-4 mt-0">
          {arollAnalyses.length > 0 ? (
            <div className="space-y-4">
              {/* Trim stats summary */}
              {trimStats && trimStats.savedSeconds > 0 && (
                <Card className="border-orange-200 bg-orange-50/50 dark:border-orange-900 dark:bg-orange-950/30">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Original total</span>
                      <span>{trimStats.originalTotal.toFixed(1)}s</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">After trimming</span>
                      <span className="font-medium">{trimStats.trimmedTotal.toFixed(1)}s</span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-1">
                      <span className="text-orange-600 font-medium">Silence removed</span>
                      <span className="text-orange-600 font-medium">
                        -{trimStats.savedSeconds.toFixed(1)}s
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Speaker consistency */}
              {speakerCheck && arollAnalyses.length >= 2 && (
                <Card className={
                  speakerCheck.isSameSpeaker
                    ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30"
                    : "border-yellow-200 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/30"
                }>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 text-xs">
                      {speakerCheck.isSameSpeaker ? (
                        <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
                      )}
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span>{speakerCheck.details}</span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Narrative sequence */}
              {arollSequence && (
                <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      Narrative Sequence
                      <Badge variant="outline" className="text-[10px]">
                        {(arollSequence.confidence * 100).toFixed(0)}% confidence
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground mb-3">
                      {arollSequence.narrativeSummary}
                    </p>
                    <div className="space-y-1">
                      {arollSequence.clipOrder
                        .sort((a, b) => a.position - b.position)
                        .map((item, i) => {
                          const clip = arollAnalyses.find((a) => a.fileId === item.clipId);
                          return (
                            <div key={item.clipId} className="text-xs">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-bold text-blue-600 w-4">
                                  {item.position}
                                </span>
                                <span className="font-medium truncate">
                                  {clip?.fileName ?? item.clipId}
                                </span>
                              </div>
                              <p className="text-muted-foreground ml-6">{item.reasoning}</p>
                              {i < arollSequence.clipOrder.length - 1 && (
                                <div className="ml-1.5 my-0.5">
                                  <ArrowDown className="h-3 w-3 text-blue-400" />
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Per-clip analysis */}
              {arollAnalyses.map((clip, i) => (
                <div key={clip.fileId}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-[10px]">
                      {clip.order != null ? `#${clip.order}` : `Clip ${i + 1}`}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate">
                      {clip.fileName}
                    </span>
                    {clip.trimmedDuration != null && clip.trimmedDuration < clip.analysis.duration && (
                      <Badge variant="secondary" className="text-[10px] ml-auto">
                        {clip.trimmedDuration.toFixed(1)}s / {clip.analysis.duration.toFixed(1)}s
                      </Badge>
                    )}
                  </div>
                  <TranscriptionView analysis={clip.analysis} usableSegments={clip.usableSegments} />
                </div>
              ))}
            </div>
          ) : status.aroll === "analyzing" ? (
            <AnalyzingState label="Analyzing A-roll clips..." />
          ) : (
            <EmptyState label="Upload A-roll clips to see transcription and analysis" />
          )}
        </TabsContent>
        <TabsContent value="broll" className="p-4 mt-0">
          {brollCatalog.length > 0 ? (
            <BRollCatalog entries={brollCatalog} />
          ) : status.broll === "analyzing" ? (
            <AnalyzingState label="Cataloging B-roll assets..." />
          ) : (
            <EmptyState label="Upload B-roll assets to see catalog" />
          )}
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-sm text-muted-foreground text-center">{label}</p>
    </div>
  );
}

function AnalyzingState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
