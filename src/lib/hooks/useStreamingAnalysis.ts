"use client";

import { useState, useCallback } from "react";

interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export type AnalysisStep =
  | "idle"
  | "upload"
  | "gemini_upload"
  | "processing"
  | "pass_1"
  | "pass_2"
  | "pass_3"
  | "pass_4"
  | "complete"
  | "error";

export function useStreamingAnalysis() {
  const [step, setStep] = useState<AnalysisStep>("idle");
  const [message, setMessage] = useState("");
  const [passResults, setPassResults] = useState<Record<number, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async (file: File): Promise<Record<string, unknown> | null> => {
    setStep("upload");
    setMessage("Preparing upload...");
    setError(null);
    setPassResults({});

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/analyze/reference", {
        method: "POST",
        body: formData,
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const parsed: StreamEvent = JSON.parse(line.slice(6));

          switch (parsed.event) {
            case "status":
              setStep(parsed.data.step as AnalysisStep);
              setMessage(parsed.data.message as string);
              break;
            case "progress":
              setStep(`pass_${parsed.data.pass}` as AnalysisStep);
              setMessage(parsed.data.message as string);
              break;
            case "pass_complete":
              setPassResults((prev) => ({
                ...prev,
                [parsed.data.pass as number]: parsed.data.data,
              }));
              break;
            case "complete":
              setStep("complete");
              setMessage("Analysis complete!");
              finalResult = parsed.data as Record<string, unknown>;
              break;
            case "error":
              setStep("error");
              setMessage(parsed.data.message as string);
              setError(parsed.data.message as string);
              break;
          }
        }
      }

      return finalResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setStep("error");
      setMessage(msg);
      setError(msg);
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setStep("idle");
    setMessage("");
    setPassResults({});
    setError(null);
  }, []);

  return { step, message, passResults, error, analyze, reset };
}
