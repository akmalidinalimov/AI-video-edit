"use client";

import { useState, useCallback, useRef } from "react";
import type { StyleProfile } from "@/lib/style-profile/style-profile";

export type ClonePhase =
  | "idle"
  | "uploading"
  | "analyzing_reference"
  | "generating_template"
  | "building_plan"
  | "rendering"
  | "complete"
  | "error";

export interface CloneProgress {
  phase: ClonePhase;
  progress: number; // 0-100
  message: string;
  downloadUrl?: string;
  /** B1: decoded content-free StyleProfile 2.0 (shadow output, validation surface). */
  styleProfile?: StyleProfile;
}

const PHASE_LABELS: Record<string, string> = {
  uploading: "Uploading files...",
  analyzing_reference: "Analyzing reference style...",
  generating_template: "Generating layout template...",
  building_plan: "Building editing plan...",
  rendering: "Rendering video...",
  complete: "Done!",
  error: "Error",
};

export function useCloneStyle() {
  const [progress, setProgress] = useState<CloneProgress>({
    phase: "idle",
    progress: 0,
    message: "",
  });
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress({ phase: "idle", progress: 0, message: "" });
  }, []);

  const start = useCallback(
    async (files: {
      reference: File;
      aroll: File[];
      broll: File[];
    }) => {
      // Abort any existing run
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // ── Step 1: Upload files ──
        setProgress({
          phase: "uploading",
          progress: 5,
          message: "Uploading reference video...",
        });

        const uploadFile = async (file: File, label: string): Promise<string> => {
          const formData = new FormData();
          formData.append("file", file);

          const res = await fetch("/api/upload", {
            method: "POST",
            body: formData,
            signal: controller.signal,
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Upload failed" }));
            throw new Error(err.error || `Failed to upload ${label}`);
          }

          const data = await res.json();
          return data.path; // relative path like "uploads/filename.mp4"
        };

        const refPath = await uploadFile(files.reference, "reference");

        const arollPaths: string[] = [];
        for (let i = 0; i < files.aroll.length; i++) {
          setProgress({
            phase: "uploading",
            progress: 6 + i,
            message: `Uploading A-roll ${i + 1}/${files.aroll.length}...`,
          });
          arollPaths.push(await uploadFile(files.aroll[i], `A-roll ${i + 1}`));
        }

        const brollPaths: string[] = [];
        for (let i = 0; i < files.broll.length; i++) {
          setProgress({
            phase: "uploading",
            progress: 8 + i,
            message: `Uploading B-roll ${i + 1}/${files.broll.length}...`,
          });
          brollPaths.push(await uploadFile(files.broll[i], `B-roll ${i + 1}`));
        }

        // ── Step 2: Start clone-style pipeline (SSE) ──
        setProgress({
          phase: "analyzing_reference",
          progress: 10,
          message: "Starting pipeline...",
        });

        const res = await fetch("/api/clone-style", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referenceVideo: refPath,
            arollVideos: arollPaths,
            brollVideos: brollPaths,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ message: "Pipeline failed" }));
          throw new Error(errData.message || `HTTP ${res.status}`);
        }

        // Parse SSE stream
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
              const event = JSON.parse(trimmed.slice(6));

              if (event.phase === "error") {
                setProgress({
                  phase: "error",
                  progress: -1,
                  message: event.message || "Pipeline failed",
                });
                return;
              }

              if (event.phase === "complete") {
                setProgress({
                  phase: "complete",
                  progress: 100,
                  message: event.message || "Done!",
                  downloadUrl: event.downloadUrl,
                  styleProfile: event.styleProfile,
                });
                return;
              }

              setProgress({
                phase: event.phase as ClonePhase,
                progress: event.progress ?? 0,
                message:
                  event.message ||
                  PHASE_LABELS[event.phase] ||
                  "Processing...",
              });
            } catch {
              // Skip non-JSON lines
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return; // User cancelled
        setProgress({
          phase: "error",
          progress: -1,
          message: err instanceof Error ? err.message : "Pipeline failed",
        });
      }
    },
    []
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress({ phase: "idle", progress: 0, message: "" });
  }, []);

  return {
    progress,
    start,
    cancel,
    reset,
    isRunning:
      progress.phase !== "idle" &&
      progress.phase !== "complete" &&
      progress.phase !== "error",
    isComplete: progress.phase === "complete",
    isError: progress.phase === "error",
  };
}
