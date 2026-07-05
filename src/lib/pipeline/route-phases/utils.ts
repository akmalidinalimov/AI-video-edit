/**
 * Shared utilities for the clone-style route phases (Wave 0.5 decomposition).
 * Moved verbatim from src/app/api/clone-style/route.ts — no behavior change.
 */

import path from "path";
import fs from "fs";

export function getFFmpegPath(): string {
  const root = process.cwd();
  // Windows dev
  const winPath = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
  if (fs.existsSync(winPath)) return winPath;
  // Linux deploy
  if (fs.existsSync("/usr/bin/ffmpeg")) return "/usr/bin/ffmpeg";
  // Env override
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  throw new Error("FFmpeg not found. Set FFMPEG_PATH environment variable.");
}

/** Retry with exponential backoff for Gemini API calls */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable =
        message.includes("503") ||
        message.includes("429") ||
        message.includes("overloaded") ||
        message.includes("high demand");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[clone-style] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry exhausted");
}
