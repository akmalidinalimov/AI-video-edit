/**
 * POST /api/upload — File Upload Endpoint
 *
 * Accepts a single video file via FormData and saves it to public/uploads/.
 * Validates:
 *   - File type: MP4 or MOV only
 *   - File size: < 500MB
 *   - Duration: < 120s (checked via FFprobe if available)
 *
 * Returns: { path: "uploads/filename.ext", size: number }
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export const maxDuration = 300;

const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB (Gemini File API ceiling)
const MAX_DURATION_SECONDS = 600; // 10 minutes — allow long reference videos
const ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",        // .MOV
  "video/x-quicktime",
  "video/x-m4v",
]);
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);

function getFFprobePath(): string | null {
  const root = process.cwd();
  // Windows: check if ffprobe exists next to ffmpeg
  const winFFmpegDir = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64");
  const winProbe = path.join(winFFmpegDir, "ffprobe.exe");
  if (fs.existsSync(winProbe)) return winProbe;
  // Linux
  if (fs.existsSync("/usr/bin/ffprobe")) return "/usr/bin/ffprobe";
  // Env
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH))
    return process.env.FFPROBE_PATH;
  return null;
}

async function getVideoDuration(filePath: string): Promise<number | null> {
  const ffprobe = getFFprobePath();
  if (!ffprobe) return null;

  return new Promise((resolve) => {
    const proc = spawn(ffprobe, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ]);

    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      try {
        const parsed = JSON.parse(stdout);
        const dur = parseFloat(parsed.format?.duration);
        resolve(isNaN(dur) ? null : dur);
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

function sanitizeFilename(name: string): string {
  // Remove path separators and other dangerous characters
  return name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_");
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file provided. Send a file in the 'file' field." },
        { status: 400 }
      );
    }

    // ── Validate file type ──
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Invalid file type: ${ext}. Only MP4 and MOV files are accepted.` },
        { status: 400 }
      );
    }

    // Also check MIME type if available (browsers set this)
    if (file.type && !ALLOWED_TYPES.has(file.type.toLowerCase())) {
      // Some browsers report wrong MIME types, so just warn but allow if extension is ok
      console.warn(`[upload] MIME type ${file.type} doesn't match expected video types for ${file.name}`);
    }

    // ── Validate file size ──
    if (file.size > MAX_SIZE_BYTES) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(0);
      return NextResponse.json(
        { error: `File too large: ${sizeMB}MB. Maximum is 2GB.` },
        { status: 400 }
      );
    }

    // ── Save file ──
    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Add timestamp prefix to avoid collisions
    const timestamp = Date.now();
    const safeName = sanitizeFilename(file.name);
    const filename = `${timestamp}_${safeName}`;
    const filePath = path.join(uploadsDir, filename);

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // ── Validate duration (best-effort) ──
    const duration = await getVideoDuration(filePath);
    if (duration !== null && duration > MAX_DURATION_SECONDS) {
      // Clean up the file
      fs.unlinkSync(filePath);
      return NextResponse.json(
        {
          error: `Video too long: ${Math.ceil(duration)}s. Maximum is ${MAX_DURATION_SECONDS}s.`,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      path: `uploads/${filename}`,
      size: file.size,
      duration: duration ?? undefined,
    });
  } catch (error) {
    console.error("[/api/upload] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
