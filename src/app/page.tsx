"use client";

import { useState, useCallback } from "react";
import { UploadPanel } from "@/components/workspace/UploadPanel";
import { PreviewCanvas } from "@/components/workspace/PreviewCanvas";
import { AnalysisPanel } from "@/components/workspace/AnalysisPanel";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { TimelineView } from "@/components/timeline/TimelineView";
import { ExportPanel } from "@/components/export/ExportPanel";
import { TemplatePanel } from "@/components/templates/TemplatePanel";
import { ComparisonView } from "@/components/comparison/ComparisonView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Zap, Wand2, RotateCcw, History, ScanEye } from "lucide-react";
import { useStreamingAnalysis } from "@/lib/hooks/useStreamingAnalysis";
import { checkSpeakerConsistency } from "@/lib/analysis/speakerConsistency";
import type {
  UploadedFile, ARollClipAnalysis, ARollSequence, SpeakerConsistency,
  BRollCatalogEntry, AnalysisStatus, MatchResult,
} from "@/lib/types/project";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { TimelineDefinition, TransitionPlan, EngagementHook, MissingAssetPrompt } from "@/lib/types/timeline";
import type { ContentSegment } from "@/lib/matching/segmenter";
import type { SegmentRenderDescription } from "@/lib/matching/renderDescriptions";
import type { EditCommand, TimelineVersion } from "@/lib/types/editCommand";
import type { VisualBlueprint } from "@/lib/types/blueprint";

function createUploadedFile(file: File): UploadedFile {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    type: file.type.startsWith("video/") ? "video" : "image",
    mimeType: file.type,
    size: file.size,
    url: URL.createObjectURL(file),
    status: "idle",
    progress: 0,
  };
}

async function sequenceClips(analyses: ARollClipAnalysis[]): Promise<ARollSequence | null> {
  try {
    const clips = analyses.map((a) => ({
      id: a.fileId,
      fileName: a.fileName,
      summary: a.analysis.clip_summary || "",
      transcription: a.analysis.transcription.full_text,
      duration: a.analysis.duration,
    }));

    const res = await fetch("/api/analyze/aroll-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips }),
    });

    if (!res.ok) return null;
    const data = await res.json();

    return {
      clipOrder: data.sequence.map((s: { clip_id: string; position: number; reasoning: string }) => ({
        clipId: s.clip_id,
        position: s.position,
        reasoning: s.reasoning,
      })),
      narrativeSummary: data.narrative_summary,
      confidence: data.confidence,
    };
  } catch (err) {
    console.error("Sequencing failed:", err);
    return null;
  }
}

function applyPostProcessing(clips: ARollClipAnalysis[]): ARollClipAnalysis[] {
  // Use the FULL A-roll without silence cutting.
  // Silence removal caused A-roll to repeat by compressing timeline
  // timestamps while the source video played from 0 each segment.
  return clips.map((clip) => ({
    ...clip,
    usableSegments: undefined,
    trimmedDuration: undefined,
  }));
}

export default function Home() {
  // Phase 1 state
  const [referenceFile, setReferenceFile] = useState<UploadedFile | null>(null);
  const [arollFiles, setArollFiles] = useState<UploadedFile[]>([]);
  const [brollFiles, setBrollFiles] = useState<UploadedFile[]>([]);
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [arollAnalyses, setArollAnalyses] = useState<ARollClipAnalysis[]>([]);
  const [arollSequence, setArollSequence] = useState<ARollSequence | null>(null);
  const [speakerCheck, setSpeakerCheck] = useState<SpeakerConsistency | null>(null);
  const [brollCatalog, setBrollCatalog] = useState<BRollCatalogEntry[]>([]);

  // V2 Blueprint state
  const [blueprint, setBlueprint] = useState<VisualBlueprint | null>(null);
  const [blueprintStatus, setBlueprintStatus] = useState<"idle" | "analyzing" | "complete" | "error">("idle");
  const [blueprintProgress, setBlueprintProgress] = useState<{ step: number; total: number; message: string } | null>(null);
  const [blueprintError, setBlueprintError] = useState<string | null>(null);

  // Phase 2 state
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [timeline, setTimeline] = useState<TimelineDefinition | null>(null);
  const [contentSegments, setContentSegments] = useState<ContentSegment[] | null>(null);
  const [transitions, setTransitions] = useState<TransitionPlan[]>([]);
  const [engagementHook, setEngagementHook] = useState<EngagementHook | null>(null);
  const [missingAssetPrompts, setMissingAssetPrompts] = useState<MissingAssetPrompt[]>([]);
  const [renderDescriptions, setRenderDescriptions] = useState<SegmentRenderDescription[]>([]);
  const [optimizerChanges, setOptimizerChanges] = useState<{ segmentId: string; from: string; to: string; reason: string }[]>([]);
  const [matchStats, setMatchStats] = useState<{
    totalSegments: number;
    matchedSegments: number;
    unmatchedSegments: number;
    totalDuration: number;
    avgMatchScore: number;
    captionLines: number;
    hasHook: boolean;
    missingAssets: number;
  } | null>(null);

  // Phase 4 state — iteration history
  const [timelineHistory, setTimelineHistory] = useState<TimelineVersion[]>([]);

  // Verification state
  const [verificationScore, setVerificationScore] = useState<number | null>(null);
  const [verificationDetails, setVerificationDetails] = useState<{
    passed: boolean;
    iterations: number;
    fixesApplied: string[];
    scoreHistory: number[];
    dimensions: { name: string; score: number; max: number }[];
  } | null>(null);
  const [activeView, setActiveView] = useState<"timeline" | "preview" | "comparison">("timeline");

  const [loadingDemo, setLoadingDemo] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<{
    reference: AnalysisStatus;
    aroll: AnalysisStatus;
    broll: AnalysisStatus;
    matching: AnalysisStatus;
  }>({
    reference: "idle",
    aroll: "idle",
    broll: "idle",
    matching: "idle",
  });

  const refAnalysis = useStreamingAnalysis();

  const clearMatchState = useCallback(() => {
    setTimeline(null);
    setMatchResults(null);
    setContentSegments(null);
    setMatchStats(null);
    setTransitions([]);
    setEngagementHook(null);
    setMissingAssetPrompts([]);
    setRenderDescriptions([]);
    setOptimizerChanges([]);
    setTimelineHistory([]);
    setAnalysisStatus((prev) => ({ ...prev, matching: "idle" }));
  }, []);

  // Push current timeline to history before a change
  const pushToHistory = useCallback((label: string) => {
    if (!timeline) return;
    setTimelineHistory((prev) => [
      ...prev,
      {
        id: `v${prev.length + 1}_${Date.now()}`,
        label,
        timeline: JSON.parse(JSON.stringify(timeline)),
        createdAt: new Date(),
        editSummary: label,
      },
    ]);
  }, [timeline]);

  // Restore a timeline version from history
  const restoreVersion = useCallback((version: TimelineVersion) => {
    pushToHistory("Before restore");
    setTimeline(JSON.parse(JSON.stringify(version.timeline)));
  }, [pushToHistory]);

  // Handle chat-driven timeline updates
  const handleChatUpdate = useCallback(
    (newTimeline: TimelineDefinition, commands: EditCommand[]) => {
      pushToHistory(`Before: ${commands.map((c) => c.description).join(", ")}`);
      setTimeline(newTimeline);
    },
    [pushToHistory]
  );

  // Handle direct segment edits from SegmentEditor
  const handleSegmentUpdate = useCallback(
    (segmentId: string, updates: Record<string, unknown>) => {
      if (!timeline) return;
      pushToHistory("Before segment edit");
      setTimeline({
        ...timeline,
        segments: timeline.segments.map((s) =>
          s.id === segmentId ? { ...s, ...updates } : s
        ),
      });
    },
    [timeline, pushToHistory]
  );

  // Load a template as the style profile
  const handleLoadTemplate = useCallback((profile: StyleProfile) => {
    setStyleProfile(profile);
    clearMatchState();
  }, [clearMatchState]);

  const runMatching = useCallback(async () => {
    if (!styleProfile || arollAnalyses.length === 0) return;

    setAnalysisStatus((prev) => ({ ...prev, matching: "analyzing" }));
    setMatchResults(null);
    setTimeline(null);
    setContentSegments(null);
    setMatchStats(null);
    setTransitions([]);
    setEngagementHook(null);
    setMissingAssetPrompts([]);
    setRenderDescriptions([]);
    setOptimizerChanges([]);
    setTimelineHistory([]);

    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          styleProfile,
          arollAnalyses,
          arollSequence,
          brollCatalog,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Matching failed");
      }

      const data = await res.json();
      setMatchResults(data.matches);
      setTimeline(data.timeline);
      setContentSegments(data.contentSegments);
      setMatchStats(data.stats);
      setTransitions(data.transitions ?? []);
      setEngagementHook(data.hook ?? null);
      setMissingAssetPrompts(data.missingAssetPrompts ?? []);
      setRenderDescriptions(data.renderDescriptions ?? []);
      setOptimizerChanges(data.optimizerChanges ?? []);

      // Store verification results
      if (data.verification) {
        setVerificationScore(data.verification.score);
        setVerificationDetails({
          passed: data.verification.passed,
          iterations: data.verification.iterations,
          fixesApplied: data.verification.fixesApplied ?? [],
          scoreHistory: data.verification.scoreHistory ?? [],
          dimensions: data.verification.dimensions ?? [],
        });
      }

      setAnalysisStatus((prev) => ({ ...prev, matching: "complete" }));
    } catch (err) {
      console.error("Matching failed:", err);
      setAnalysisStatus((prev) => ({ ...prev, matching: "error" }));
    }
  }, [styleProfile, arollAnalyses, arollSequence, brollCatalog]);

  // ── V2 Blueprint Analysis (SSE) ──
  const runBlueprintAnalysis = useCallback(async () => {
    if (!referenceFile || arollFiles.length === 0) return;

    setBlueprintStatus("analyzing");
    setBlueprintError(null);
    setBlueprint(null);
    setBlueprintProgress(null);

    try {
      // Build paths relative to public/ — files live in public/uploads/
      const refName = referenceFile.name;
      const arollName = arollFiles[0].name;
      const brollNames = brollFiles.map((f) => f.name);

      const res = await fetch("/api/analyze/blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceVideo: `uploads/${refName}`,
          arollVideo: `uploads/${arollName}`,
          brollVideos: brollNames.map((n) => `uploads/${n}`),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No readable stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const { event, data } = parsed;

            if (event === "progress") {
              setBlueprintProgress({
                step: data.step,
                total: data.total,
                message: data.message,
              });
            } else if (event === "status") {
              setBlueprintProgress((prev) => prev ? { ...prev, message: data.message } : null);
            } else if (event === "step_complete") {
              // keep progress visible
            } else if (event === "complete") {
              setBlueprint(data.blueprint);
              setBlueprintStatus("complete");
            } else if (event === "error") {
              throw new Error(data.message ?? "Blueprint analysis failed");
            }
          } catch (parseErr) {
            // Ignore non-JSON lines
            if (parseErr instanceof Error && parseErr.message.includes("Blueprint")) throw parseErr;
          }
        }
      }

      // If we exited the loop without getting a blueprint, treat as error
      setBlueprintStatus((prev) => prev === "analyzing" ? "error" : prev);
    } catch (err) {
      console.error("Blueprint analysis failed:", err);
      setBlueprintError(err instanceof Error ? err.message : String(err));
      setBlueprintStatus("error");
    }
  }, [referenceFile, arollFiles, brollFiles]);

  const loadDemo = useCallback(async () => {
    setLoadingDemo(true);
    try {
      const res = await fetch("/api/demo");
      if (!res.ok) throw new Error("Demo data not found");
      const data = await res.json();

      setStyleProfile(data.styleProfile);
      if (data.arollAnalysis) {
        const clip: ARollClipAnalysis = {
          fileId: "demo_aroll",
          fileName: "IMG_6108.MOV",
          analysis: data.arollAnalysis,
          order: 0,
        };
        const processed = applyPostProcessing([clip]);
        setArollAnalyses(processed);
      }
      setBrollCatalog(data.brollCatalog);
      setReferenceFile({
        id: "demo_ref", name: "IMG_6018.MOV", type: "video",
        mimeType: "video/quicktime", size: 16800000, url: "", status: "complete", progress: 100,
      });
      setArollFiles([{
        id: "demo_aroll", name: "IMG_6108.MOV", type: "video",
        mimeType: "video/quicktime", size: 17600000, url: "", status: "complete", progress: 100,
      }]);
      setBrollFiles([{
        id: "demo_broll", name: "IMG_6163.MP4", type: "video",
        mimeType: "video/mp4", size: 13500000, url: "", status: "complete", progress: 100,
      }]);
      setAnalysisStatus({
        reference: "complete", aroll: "complete", broll: "complete", matching: "idle",
      });
    } catch (err) {
      console.error("Failed to load demo:", err);
    } finally {
      setLoadingDemo(false);
    }
  }, []);

  const handleReferenceUpload = useCallback(async (files: File[]) => {
    const file = files[0];
    const uploaded = createUploadedFile(file);
    uploaded.status = "processing";
    setReferenceFile(uploaded);
    setAnalysisStatus((prev) => ({ ...prev, reference: "analyzing" }));

    const result = await refAnalysis.analyze(file);
    if (result) {
      setStyleProfile(result.styleProfile as unknown as StyleProfile);
      setAnalysisStatus((prev) => ({ ...prev, reference: "complete" }));
      setReferenceFile((prev) => prev ? { ...prev, status: "complete", progress: 100 } : prev);
    } else {
      setAnalysisStatus((prev) => ({ ...prev, reference: "error" }));
      setReferenceFile((prev) => prev ? { ...prev, status: "error" } : prev);
    }
  }, [refAnalysis]);

  const handleArollUpload = useCallback(async (files: File[]) => {
    const uploaded = files.map((f) => {
      const u = createUploadedFile(f);
      u.status = "processing";
      return u;
    });
    setArollFiles((prev) => [...prev, ...uploaded]);
    setAnalysisStatus((prev) => ({ ...prev, aroll: "analyzing" }));
    setArollSequence(null);
    setSpeakerCheck(null);

    const newAnalyses: ARollClipAnalysis[] = [];
    let allSuccess = true;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = uploaded[i].id;

      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/analyze/aroll", { method: "POST", body: formData });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Analysis failed");
        }

        const data = await res.json();
        const clip: ARollClipAnalysis = {
          fileId,
          fileName: file.name,
          analysis: data.analysis,
        };
        newAnalyses.push(clip);

        const processed = applyPostProcessing([clip])[0];
        setArollAnalyses((prev) => [...prev, processed]);
        setArollFiles((prev) =>
          prev.map((f) => f.id === fileId ? { ...f, status: "complete" as const, progress: 100 } : f)
        );
      } catch (err) {
        console.error(`A-roll analysis failed for ${file.name}:`, err);
        allSuccess = false;
        setArollFiles((prev) =>
          prev.map((f) => f.id === fileId ? { ...f, status: "error" as const } : f)
        );
      }
    }

    if (allSuccess) {
      setAnalysisStatus((prev) => ({ ...prev, aroll: "complete" }));

      setArollAnalyses((currentAnalyses) => {
        if (currentAnalyses.length >= 2) {
          const consistency = checkSpeakerConsistency(currentAnalyses);
          setSpeakerCheck(consistency);

          sequenceClips(currentAnalyses).then((seq) => {
            if (seq) {
              setArollSequence(seq);
              setArollAnalyses((prev) =>
                prev.map((a) => {
                  const seqItem = seq.clipOrder.find((s) => s.clipId === a.fileId);
                  return seqItem ? { ...a, order: seqItem.position } : a;
                })
              );
            }
          });
        }
        return currentAnalyses;
      });
    } else {
      setAnalysisStatus((prev) => ({ ...prev, aroll: "error" }));
    }
  }, []);

  const handleBrollUpload = useCallback(async (files: File[]) => {
    const uploaded = files.map((f) => {
      const u = createUploadedFile(f);
      u.status = "processing";
      return u;
    });
    setBrollFiles((prev) => [...prev, ...uploaded]);
    setAnalysisStatus((prev) => ({ ...prev, broll: "analyzing" }));

    let allSuccess = true;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = uploaded[i].id;

      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/analyze/broll", { method: "POST", body: formData });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Analysis failed");
        }

        const data = await res.json();
        setBrollCatalog((prev) => [...prev, data.entry]);
        setBrollFiles((prev) =>
          prev.map((f) => f.id === fileId ? { ...f, status: "complete" as const, progress: 100 } : f)
        );
      } catch (err) {
        console.error(`B-roll analysis failed for ${file.name}:`, err);
        allSuccess = false;
        setBrollFiles((prev) =>
          prev.map((f) => f.id === fileId ? { ...f, status: "error" as const } : f)
        );
      }
    }

    setAnalysisStatus((prev) => ({
      ...prev,
      broll: allSuccess ? "complete" : "error",
    }));
  }, []);

  const hasAnalysis = !!styleProfile || arollAnalyses.length > 0 || brollCatalog.length > 0;
  const canMatch = !!styleProfile && arollAnalyses.length > 0 && analysisStatus.matching !== "analyzing";
  const isMatching = analysisStatus.matching === "analyzing";
  const hasTimeline = !!timeline && !!matchResults && !!contentSegments && !!matchStats;

  const sortedAnalyses = arollSequence
    ? [...arollAnalyses].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    : arollAnalyses;

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-4 py-2 border-b bg-background">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">StyleClone</h1>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">v2.0</span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={loadDemo}
            disabled={loadingDemo || hasAnalysis}
            className="gap-1.5"
          >
            {loadingDemo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Load Demo
          </Button>
          <Button
            size="sm"
            onClick={runMatching}
            disabled={!canMatch}
            className="gap-1.5"
          >
            {isMatching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {isMatching ? "Matching..." : hasTimeline ? "Regenerate" : "Generate Edit"}
          </Button>

          {/* V2 Blueprint Analysis */}
          <Button
            variant={blueprintStatus === "complete" ? "outline" : "default"}
            size="sm"
            onClick={runBlueprintAnalysis}
            disabled={!referenceFile || arollFiles.length === 0 || blueprintStatus === "analyzing"}
            className="gap-1.5"
          >
            {blueprintStatus === "analyzing" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanEye className="h-3.5 w-3.5" />
            )}
            {blueprintStatus === "analyzing"
              ? (blueprintProgress ? `Step ${blueprintProgress.step}/${blueprintProgress.total}` : "Analyzing...")
              : blueprintStatus === "complete"
                ? "V2 Ready ✓"
                : "V2 Analysis"}
          </Button>
          {blueprintStatus === "analyzing" && blueprintProgress && (
            <span className="text-[10px] text-muted-foreground max-w-[200px] truncate">
              {blueprintProgress.message}
            </span>
          )}
          {blueprintStatus === "error" && (
            <span className="text-[10px] text-destructive truncate max-w-[150px]" title={blueprintError ?? ""}>
              ⚠ Failed
            </span>
          )}

          {/* View switcher */}
          {hasTimeline && (
            <div className="flex gap-1 border rounded-md p-0.5">
              {(["timeline", "preview", "comparison"] as const).map((view) => (
                <Button
                  key={view}
                  variant={activeView === view ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setActiveView(view)}
                >
                  {view.charAt(0).toUpperCase() + view.slice(1)}
                </Button>
              ))}
            </div>
          )}

          {/* Verification score badge */}
          {verificationScore !== null && (
            <div
              className="flex items-center gap-1 cursor-pointer"
              title={verificationDetails
                ? `${verificationDetails.iterations} iterations, ${verificationDetails.fixesApplied.length} auto-fixes\n${verificationDetails.dimensions?.map((d) => `${d.name}: ${d.score}/${d.max}`).join("\n") ?? ""}`
                : ""}
            >
              <Badge
                variant={verificationScore >= 95 ? "default" : verificationScore >= 80 ? "secondary" : "destructive"}
                className="text-[9px] gap-1"
              >
                {verificationScore >= 95 ? "✓" : "⚠"} {verificationScore}%
              </Badge>
              {verificationDetails && verificationDetails.fixesApplied.length > 0 && (
                <span className="text-[9px] text-muted-foreground">
                  {verificationDetails.fixesApplied.length} fixes
                </span>
              )}
            </div>
          )}

          {/* Version history */}
          {timelineHistory.length > 0 && (
            <div className="flex items-center gap-1">
              <History className="h-3.5 w-3.5 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">
                v{timelineHistory.length + 1}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => {
                  const last = timelineHistory[timelineHistory.length - 1];
                  if (last) restoreVersion(last);
                }}
                title="Undo last change"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            </div>
          )}

          <span className="text-xs text-muted-foreground">9:16 · 1080×1920</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 border-r flex flex-col shrink-0">
          <ErrorBoundary fallbackMessage="Upload panel error">
            <div className="flex-1 overflow-y-auto">
              <UploadPanel
                referenceFile={referenceFile}
                arollFiles={arollFiles}
                brollFiles={brollFiles}
                onReferenceUpload={handleReferenceUpload}
                onArollUpload={handleArollUpload}
                onBrollUpload={handleBrollUpload}
                onRemoveReference={() => {
                  setReferenceFile(null);
                  setStyleProfile(null);
                  refAnalysis.reset();
                  setAnalysisStatus((prev) => ({ ...prev, reference: "idle" }));
                  clearMatchState();
                }}
                onRemoveAroll={(id) => {
                  setArollFiles((prev) => prev.filter((f) => f.id !== id));
                  setArollAnalyses((prev) => prev.filter((a) => a.fileId !== id));
                  setArollSequence(null);
                  setSpeakerCheck(null);
                  clearMatchState();
                }}
                onRemoveBroll={(id) => {
                  setBrollFiles((prev) => prev.filter((f) => f.id !== id));
                  clearMatchState();
                }}
              />
              {/* Templates panel */}
              <div className="p-3 border-t">
                <TemplatePanel
                  currentProfile={styleProfile}
                  onLoadTemplate={handleLoadTemplate}
                />
              </div>
            </div>
          </ErrorBoundary>
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 p-4 overflow-auto">
            <ErrorBoundary fallbackMessage="Main view error">
              {hasTimeline && activeView === "timeline" && (
                <div className="space-y-3">
                  <TimelineView
                    timeline={timeline}
                    matches={matchResults}
                    contentSegments={contentSegments}
                    transitions={transitions}
                    hook={engagementHook}
                    missingAssetPrompts={missingAssetPrompts}
                    renderDescriptions={renderDescriptions}
                    optimizerChanges={optimizerChanges}
                    stats={matchStats}
                    brollCatalog={brollCatalog}
                    onSegmentUpdate={handleSegmentUpdate}
                  />
                  {/* Export panel below timeline */}
                  <ExportPanel timeline={timeline} blueprint={blueprint} />
                </div>
              )}

              {hasTimeline && activeView === "preview" && (
                <PreviewCanvas
                  hasContent={true}
                  timeline={timeline}
                />
              )}

              {hasTimeline && activeView === "comparison" && styleProfile && (
                <ComparisonView
                  referenceUrl={referenceFile?.url ?? ""}
                  styleProfile={styleProfile}
                  timeline={timeline}
                />
              )}

              {!hasTimeline && (
                <PreviewCanvas
                  hasContent={!!styleProfile && arollAnalyses.length > 0}
                  timeline={timeline}
                />
              )}
            </ErrorBoundary>
          </div>
          <div className="h-48 shrink-0">
            <ErrorBoundary fallbackMessage="Chat error">
              <ChatPanel
                timeline={timeline}
                onTimelineUpdate={handleChatUpdate}
              />
            </ErrorBoundary>
          </div>
        </main>

        <aside className="w-80 border-l flex flex-col shrink-0">
          <ErrorBoundary fallbackMessage="Analysis panel error">
            <AnalysisPanel
              styleProfile={styleProfile}
              arollAnalyses={sortedAnalyses}
              arollSequence={arollSequence}
              speakerCheck={speakerCheck}
              brollCatalog={brollCatalog}
              status={analysisStatus}
              referenceProgress={refAnalysis}
            />
          </ErrorBoundary>
        </aside>
      </div>
    </div>
  );
}
