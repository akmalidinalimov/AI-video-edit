/**
 * Test drawtext filter escaping in filter_complex_script file context.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const TEMP = path.join(ROOT, "public", "exports", "temp");

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });

function runFFmpeg(args, label) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        const errLines = stderr.split("\n").filter(l => l.includes("Error") || l.includes("error") || l.includes("Invalid")).slice(0, 5);
        console.error(`[${label}] EXIT ${code}: ${errLines.join(" | ")}`);
        // last 5 lines
        console.error(stderr.split("\n").slice(-5).join("\n"));
      } else {
        console.log(`[${label}] ✓ Success`);
      }
      resolve({ code, stderr });
    });
  });
}

// Test variations of font path escaping in a filter_complex_script file
const tests = [
  { label: "single-backslash-colon", fontpath: "C\\:/Windows/Fonts/arial.ttf" },
  { label: "double-backslash-colon", fontpath: "C\\\\:/Windows/Fonts/arial.ttf" },
  { label: "forward-slash-only", fontpath: "C:/Windows/Fonts/arial.ttf" },
];

for (const t of tests) {
  // Test with Uzbek text containing apostrophes and special chars
  const text = "2026 yil SMM mutaxassis kerak emas!";
  const filterContent = `color=black:s=1080:1920:r=30:d=1[bg];[bg]drawtext=fontfile='${t.fontpath}':text='${text}':fontsize=40:fontcolor=0xFFFFFF:x=100:y=100[out]`;
  const filterFile = path.join(TEMP, `test-${t.label}.txt`);
  const outFile = path.join(TEMP, `test-${t.label}.png`);

  fs.writeFileSync(filterFile, filterContent);
  console.log(`\nTesting: ${t.label}`);
  console.log(`Filter: ${filterContent}`);

  await runFFmpeg([
    "-y", "-f", "lavfi", "-i", "color=black:s=1080x1920:d=1",
    "-filter_complex_script", filterFile,
    "-map", "[out]", "-frames:v", "1", outFile
  ], t.label);

  try { fs.unlinkSync(filterFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
}

// Also test with unicode chars
console.log("\n--- Unicode text test ---");
const unicodeText = "Yangi chat bo’yicha";
const filterContent = `color=black:s=1080:1920:r=30:d=1[bg];[bg]drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${unicodeText}':fontsize=40:fontcolor=0xFFFFFF:x=100:y=100[out]`;
const filterFile = path.join(TEMP, "test-unicode.txt");
const outFile = path.join(TEMP, "test-unicode.png");
fs.writeFileSync(filterFile, filterContent);
await runFFmpeg([
  "-y", "-f", "lavfi", "-i", "color=black:s=1080x1920:d=1",
  "-filter_complex_script", filterFile,
  "-map", "[out]", "-frames:v", "1", outFile
], "unicode");
try { fs.unlinkSync(filterFile); } catch {}
try { fs.unlinkSync(outFile); } catch {}
