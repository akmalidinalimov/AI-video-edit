/**
 * run-demo.mjs — drive the real /api/clone-style pipeline end-to-end (Gemini
 * analysis → plan-builder [with pacing] → face-safe render), using the files the
 * user already uploaded. Streams SSE progress and prints the final downloadUrl.
 */
const BASE = process.env.BASE || "http://localhost:3000";
const body = {
  referenceVideo: "uploads/1782174583392_target_2split.mp4",
  arollVideos: [
    "uploads/aroll-clean.mp4",
  ],
  brollVideos: [
    // Real footage — the 5 on-topic AI CREATORS event clips.
    "uploads/1782174583953_IMG_6525.MP4",
    "uploads/1782174584044_IMG_6533.MP4",
    "uploads/1782174584186_IMG_6569.MP4",
    "uploads/1782174584404_IMG_6570.MP4",
    "uploads/1782174584649_IMG_6572.MP4",
    // Generated (Kling 3.0 turbo) — the NEW varied, diversity-pass set (0 laptops, 7 settings).
    "uploads/generated/broll-s0-hook.mp4",
    "uploads/generated/broll-s1a-kitchen.mp4",
    "uploads/generated/broll-s1b-coworking.mp4",
    "uploads/generated/broll-s2a-park.mp4",
    "uploads/generated/broll-s2b-desk.mp4",
    "uploads/generated/broll-s2c-street.mp4",
    "uploads/generated/broll-s5-studio.mp4",
  ],
  skipVerification: true,
};

const res = await fetch(`${BASE}/api/clone-style`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let lastPhase = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    if (ev.phase !== lastPhase) {
      console.log(`[${ev.progress}%] ${ev.phase}: ${ev.message ?? ""}`);
      lastPhase = ev.phase;
    }
    if (ev.downloadUrl) console.log(`DOWNLOAD: ${ev.downloadUrl}`);
    if (ev.phase === "error") { console.error(`PIPELINE ERROR: ${ev.message}`); process.exit(1); }
  }
}
console.log("STREAM ENDED");
