"use client";

import { CheckCircle, Loader2, Circle } from "lucide-react";
import type { AnalysisStep } from "@/lib/hooks/useStreamingAnalysis";

interface ReferenceProgressProps {
  step: AnalysisStep;
  message: string;
}

const PASSES = [
  { key: "pass_1", label: "Structure Scan" },
  { key: "pass_2", label: "Visual Elements" },
  { key: "pass_3", label: "Audio-Visual Sync" },
  { key: "pass_4", label: "Style Fingerprint" },
] as const;

function getPassIndex(step: AnalysisStep): number {
  const match = step.match(/^pass_(\d)$/);
  return match ? parseInt(match[1]) - 1 : -1;
}

export function ReferenceProgress({ step, message }: ReferenceProgressProps) {
  const currentPassIndex = getPassIndex(step);
  const isUploading = ["upload", "gemini_upload", "processing"].includes(step);
  const isComplete = step === "complete";
  const isError = step === "error";

  return (
    <div className="space-y-3 py-4">
      {isUploading && (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>{message}</span>
        </div>
      )}

      {(currentPassIndex >= 0 || isComplete) && (
        <div className="space-y-2">
          {PASSES.map((pass, i) => {
            const isDone = isComplete || i < currentPassIndex;
            const isCurrent = i === currentPassIndex && !isComplete;

            return (
              <div key={pass.key} className="flex items-center gap-2 text-sm">
                {isDone && <CheckCircle className="h-4 w-4 text-green-600" />}
                {isCurrent && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                {!isDone && !isCurrent && <Circle className="h-4 w-4 text-muted-foreground/30" />}
                <span className={isCurrent ? "font-medium" : isDone ? "text-muted-foreground" : "text-muted-foreground/50"}>
                  {pass.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {isError && (
        <div className="text-sm text-destructive">{message}</div>
      )}

      {isComplete && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CheckCircle className="h-4 w-4" />
          <span>Analysis complete!</span>
        </div>
      )}
    </div>
  );
}
