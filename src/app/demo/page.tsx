"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCloneStyle, type ClonePhase } from "@/lib/hooks/useCloneStyle";
import { StyleCard } from "@/components/analysis/StyleCard";
import type { StyleProfile } from "@/lib/style-profile/style-profile";
import {
  Upload,
  Film,
  Camera,
  Clapperboard,
  Loader2,
  Download,
  RotateCcw,
  X,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════

interface VideoSlot {
  file: File | null;
  preview: string | null;
}

type SlotKey = "reference" | "aroll" | "broll";

// ════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".mp4", ".mov", ".m4v"];

const SLOT_CONFIG: Record<
  SlotKey,
  { label: string; description: string; icon: typeof Film }
> = {
  reference: {
    label: "Reference Video",
    description: "The style you want to clone",
    icon: Film,
  },
  aroll: {
    label: "A-Roll (Speaker)",
    description: "Your talking-head footage",
    icon: Camera,
  },
  broll: {
    label: "B-Roll (Cutaway)",
    description: "Supporting footage / screen recordings",
    icon: Clapperboard,
  },
};

const PHASE_CONFIG: Record<
  string,
  { label: string; color: string; step: number }
> = {
  uploading: { label: "Uploading", color: "bg-blue-500", step: 1 },
  analyzing_reference: { label: "Analyzing Style", color: "bg-purple-500", step: 2 },
  generating_template: { label: "Generating Template", color: "bg-violet-500", step: 3 },
  building_plan: { label: "Building Plan", color: "bg-indigo-500", step: 4 },
  rendering: { label: "Rendering", color: "bg-emerald-500", step: 5 },
  complete: { label: "Complete", color: "bg-green-500", step: 6 },
  error: { label: "Error", color: "bg-red-500", step: 0 },
};

// ════════════════════════════════════════════════════════════
// Validation
// ════════════════════════════════════════════════════════════

function validateFile(file: File): string | null {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `Invalid format: ${ext}. Use MP4 or MOV.`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `Too large: ${(file.size / 1024 / 1024).toFixed(0)}MB. Max 500MB.`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// Drop Zone Component
// ════════════════════════════════════════════════════════════

function DropZone({
  slot,
  video,
  onFile,
  onClear,
  disabled,
}: {
  slot: SlotKey;
  video: VideoSlot;
  onFile: (file: File) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const config = SLOT_CONFIG[slot];
  const Icon = config.icon;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      const err = validateFile(file);
      if (err) {
        setError(err);
        return;
      }
      onFile(file);
    },
    [onFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [disabled, handleFile]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset input so same file can be re-selected
      e.target.value = "";
    },
    [handleFile]
  );

  if (video.file) {
    return (
      <Card className="relative group">
        <CardContent className="p-0">
          {video.preview && (
            <video
              src={video.preview}
              className="w-full aspect-video rounded-lg object-cover"
              muted
              playsInline
              onMouseEnter={(e) => (e.target as HTMLVideoElement).play().catch(() => {})}
              onMouseLeave={(e) => {
                const v = e.target as HTMLVideoElement;
                v.pause();
                v.currentTime = 0;
              }}
            />
          )}
          <div className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="size-4 text-green-500 shrink-0" />
                <span className="text-sm font-medium truncate">
                  {config.label}
                </span>
              </div>
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onClear}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {video.file.name} ({(video.file.size / 1024 / 1024).toFixed(1)}MB)
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <div
        className={`
          relative flex flex-col items-center justify-center gap-2 p-6
          border-2 border-dashed rounded-xl cursor-pointer
          transition-all duration-200
          ${dragOver ? "border-primary bg-primary/5 scale-[1.02]" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50"}
          ${disabled ? "opacity-50 pointer-events-none" : ""}
        `}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.m4v,video/mp4,video/quicktime"
          className="hidden"
          onChange={handleInput}
          disabled={disabled}
        />
        <div className="size-10 rounded-full bg-muted flex items-center justify-center">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">{config.label}</p>
          <p className="text-xs text-muted-foreground">{config.description}</p>
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          MP4 or MOV, max 500MB
        </p>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Multi Drop Zone (A-roll / B-roll — multiple files)
// ════════════════════════════════════════════════════════════

function MultiDropZone({
  slot,
  files,
  onAdd,
  onRemove,
  disabled,
}: {
  slot: "aroll" | "broll";
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  disabled: boolean;
}) {
  const config = SLOT_CONFIG[slot];
  const Icon = config.icon;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list || disabled) return;
      setError(null);
      const valid: File[] = [];
      for (const f of Array.from(list)) {
        const err = validateFile(f);
        if (err) {
          setError(err);
          continue;
        }
        valid.push(f);
      }
      if (valid.length) onAdd(valid);
    },
    [disabled, onAdd]
  );

  return (
    <div>
      {files.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-medium text-muted-foreground w-4 shrink-0">
                  {i + 1}
                </span>
                <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
                <span className="text-xs truncate">{f.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {(f.size / 1024 / 1024).toFixed(1)}MB
                </span>
              </div>
              {!disabled && (
                <button
                  onClick={() => onRemove(i)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Remove"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        className={`
          relative flex flex-col items-center justify-center gap-1.5 p-4
          border-2 border-dashed rounded-xl cursor-pointer transition-all duration-200
          ${dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50"}
          ${disabled ? "opacity-50 pointer-events-none" : ""}
        `}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          accept(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.m4v,video/mp4,video/quicktime"
          className="hidden"
          onChange={(e) => {
            accept(e.target.files);
            e.target.value = "";
          }}
          disabled={disabled}
        />
        <div className="size-8 rounded-full bg-muted flex items-center justify-center">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">
            {files.length > 0 ? `Add more ${config.label}` : config.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {slot === "aroll"
              ? "Speaker clips — upload order = sequence"
              : "Cutaways / screen recordings"}
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Multiple — MP4 or MOV, max 500MB each
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Progress Bar Component
// ════════════════════════════════════════════════════════════

function PipelineProgress({
  phase,
  progress,
  message,
}: {
  phase: ClonePhase;
  progress: number;
  message: string;
}) {
  const config = PHASE_CONFIG[phase];
  const totalSteps = 5;
  const currentStep = config?.step ?? 0;

  return (
    <div className="space-y-4">
      {/* Step indicators */}
      <div className="flex items-center gap-1">
        {Array.from({ length: totalSteps }, (_, i) => {
          const stepNum = i + 1;
          const isComplete = currentStep > stepNum;
          const isCurrent = currentStep === stepNum;
          return (
            <div key={i} className="flex-1 flex items-center gap-1">
              <div
                className={`
                  h-1.5 flex-1 rounded-full transition-all duration-500
                  ${isComplete ? "bg-green-500" : isCurrent ? config?.color ?? "bg-primary" : "bg-muted"}
                `}
              />
            </div>
          );
        })}
      </div>

      {/* Phase label + message */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span className="text-sm font-medium">
            {config?.label ?? "Processing"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {progress}%
        </span>
      </div>

      {/* Continuous progress bar */}
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${config?.color ?? "bg-primary"}`}
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>

      {/* Message */}
      <p className="text-xs text-muted-foreground text-center">{message}</p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Result Component
// ════════════════════════════════════════════════════════════

function ResultView({
  downloadUrl,
  message,
  styleProfile,
  onReset,
}: {
  downloadUrl: string;
  message: string;
  styleProfile?: StyleProfile;
  onReset: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Video player */}
      <div className="relative rounded-xl overflow-hidden bg-black">
        <video
          src={downloadUrl}
          controls
          autoPlay
          className="w-full max-h-[60vh] mx-auto"
          playsInline
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-3">
        <Button
          size="lg"
          className="gap-2"
          render={<a href={downloadUrl} download />}
        >
          <Download className="size-4" />
          Download Video
        </Button>
        <Button variant="outline" size="lg" className="gap-2" onClick={onReset}>
          <RotateCcw className="size-4" />
          Start Over
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">{message}</p>

      {/* B1 validation: the decoded content-free StyleProfile 2.0 */}
      {styleProfile && <StyleCard profile={styleProfile} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Main Demo Page
// ════════════════════════════════════════════════════════════

export default function DemoPage() {
  // Reference is single; A-roll and B-roll accept multiple files.
  const [reference, setReference] = useState<VideoSlot>({ file: null, preview: null });
  const [arolls, setArolls] = useState<File[]>([]);
  const [brolls, setBrolls] = useState<File[]>([]);

  const { progress, start, cancel, reset, isRunning, isComplete, isError } =
    useCloneStyle();

  const setReferenceFile = useCallback((file: File) => {
    setReference((prev) => {
      if (prev.preview) URL.revokeObjectURL(prev.preview);
      return { file, preview: URL.createObjectURL(file) };
    });
  }, []);

  const clearReference = useCallback(() => {
    setReference((prev) => {
      if (prev.preview) URL.revokeObjectURL(prev.preview);
      return { file: null, preview: null };
    });
  }, []);

  const allFilled = !!reference.file && arolls.length > 0 && brolls.length > 0;

  const handleStart = useCallback(() => {
    if (!reference.file || arolls.length === 0 || brolls.length === 0) return;
    start({ reference: reference.file, aroll: arolls, broll: brolls });
  }, [reference.file, arolls, brolls, start]);

  const handleReset = useCallback(() => {
    if (reference.preview) URL.revokeObjectURL(reference.preview);
    setReference({ file: null, preview: null });
    setArolls([]);
    setBrolls([]);
    reset();
  }, [reference.preview, reset]);

  const showUpload = !isRunning && !isComplete;
  const showProgress = isRunning;
  const showResult = isComplete && progress.downloadUrl;
  const showError = isError;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">StyleClone</h1>
            <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium">
              DEMO
            </span>
          </div>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Clone any video&apos;s editing style
          </p>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-4xl space-y-8">
          {/* ── Upload Zone ── */}
          {showUpload && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-2xl font-bold tracking-tight">
                  Upload Your Videos
                </h2>
                <p className="text-muted-foreground">
                  Drop a reference video, your A-roll, and B-roll footage.
                  We&apos;ll clone the editing style in seconds.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                <DropZone
                  slot="reference"
                  video={reference}
                  onFile={setReferenceFile}
                  onClear={clearReference}
                  disabled={isRunning}
                />
                <MultiDropZone
                  slot="aroll"
                  files={arolls}
                  onAdd={(fs) => setArolls((prev) => [...prev, ...fs])}
                  onRemove={(i) => setArolls((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={isRunning}
                />
                <MultiDropZone
                  slot="broll"
                  files={brolls}
                  onAdd={(fs) => setBrolls((prev) => [...prev, ...fs])}
                  onRemove={(i) => setBrolls((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={isRunning}
                />
              </div>

              <div className="flex justify-center">
                <Button
                  size="lg"
                  disabled={!allFilled || isRunning}
                  onClick={handleStart}
                  className="gap-2 px-8"
                >
                  <Upload className="size-4" />
                  Clone Style
                </Button>
              </div>
            </div>
          )}

          {/* ── Progress Zone ── */}
          {showProgress && (
            <Card className="max-w-lg mx-auto">
              <CardContent className="space-y-6">
                <div className="text-center space-y-1">
                  <h2 className="text-lg font-bold">Cloning Style...</h2>
                  <p className="text-xs text-muted-foreground">
                    This takes 1-3 minutes depending on video length
                  </p>
                </div>

                <PipelineProgress
                  phase={progress.phase}
                  progress={progress.progress}
                  message={progress.message}
                />

                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={cancel}
                    className="gap-1.5"
                  >
                    <X className="size-3" />
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Error Zone ── */}
          {showError && (
            <Card className="max-w-lg mx-auto border-destructive/50">
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-full bg-destructive/10 flex items-center justify-center">
                    <AlertCircle className="size-5 text-destructive" />
                  </div>
                  <div>
                    <h3 className="font-medium">Something went wrong</h3>
                    <p className="text-sm text-muted-foreground">
                      {progress.message}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                    className="gap-1.5"
                  >
                    <RotateCcw className="size-3" />
                    Start Over
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleStart}
                    disabled={!allFilled}
                    className="gap-1.5"
                  >
                    <RotateCcw className="size-3" />
                    Retry
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Result Zone ── */}
          {showResult && progress.downloadUrl && (
            <ResultView
              downloadUrl={progress.downloadUrl}
              message={progress.message}
              styleProfile={progress.styleProfile}
              onReset={handleReset}
            />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t px-6 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-xs text-muted-foreground">
          <span>Single-pass FFmpeg rendering. No concatenation.</span>
          <span>v5.0</span>
        </div>
      </footer>
    </div>
  );
}
