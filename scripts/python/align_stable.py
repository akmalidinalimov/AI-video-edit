"""
align_stable.py — COMMERCIAL-SAFE forced alignment (replaces the CC-BY-NC MMS aligner).

Gemini gives the correct WORDS (good Uzbek text) but its per-word TIMES drift ~300-1000ms.
This force-aligns those known words to the audio using stable-ts (MIT) on OpenAI Whisper
(MIT — code AND weights), which supports Uzbek and works for any Whisper language WITHOUT a
per-language alignment model (it uses Whisper's own attention + DTW). Fully commercial-safe.

Same CLI + side-effects as align_mms.py, so it is a drop-in behind the aligner abstraction:
  align_stable.py <audio_or_video> <transcription_json> <out_words_json>
Writes detector:"stable_ts". Model via env WHISPER_MODEL (default "small"; use "large-v3" for
best low-resource accuracy). Weights cached under scripts/python/.whisper.
"""
import os
import sys
import json
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
DL_ROOT = os.path.join(HERE, ".whisper")
os.makedirs(DL_ROOT, exist_ok=True)
FFMPEG = os.path.join(HERE, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")


def norm(w):
    w = w.strip().lower()
    for a, b in (("ʻ", "'"), ("ʼ", "'"), ("‘", "'"), ("’", "'"), ("`", "'")):
        w = w.replace(a, b)
    return re.sub(r"[^a-z0-9']", "", w)


def wav_path(src, sr=16000):
    """Decode to a mono 16k wav via ffmpeg (robust to .MOV); stable-ts reads a path."""
    out = os.path.join(DL_ROOT, f"_align_{os.getpid()}.wav")
    p = subprocess.run([FFMPEG, "-y", "-i", src, "-ac", "1", "-ar", str(sr), "-loglevel", "error", out],
                       capture_output=True)
    if p.returncode != 0 or not os.path.exists(out):
        raise SystemExit(f"ffmpeg failed for {src}: {p.stderr[:200]}")
    return out


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: align_stable.py <audio> <transcription_json> <out_words_json>")
    audio_path, tr_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    tr = json.load(open(tr_path, encoding="utf-8"))
    raw_words = [w.get("word", "") for w in tr.get("words", [])]
    if not raw_words:
        raise SystemExit("no words in transcription")
    lang = tr.get("language", "uz")

    import stable_whisper
    model_name = os.environ.get("WHISPER_MODEL", "small")
    model = stable_whisper.load_model(model_name, download_root=DL_ROOT)

    wav = wav_path(audio_path)
    try:
        # FORCED alignment of the KNOWN words to the audio (not fresh transcription).
        result = model.align(wav, " ".join(raw_words), language=lang)
    finally:
        try: os.remove(wav)
        except OSError: pass

    aligned = result.all_words()  # WordTiming: .word .start .end .probability, in order

    # Map aligned words back to the ORIGINAL word order. stable-ts preserves input order, so a
    # greedy normalized match in sequence is robust to tokenization/punctuation differences.
    out_words = [None] * len(raw_words)
    j = 0
    for i, rw in enumerate(raw_words):
        rn = norm(rw)
        if not rn:
            continue
        # advance j to the next aligned word whose normalized text matches (bounded look-ahead)
        k = j
        while k < len(aligned) and k < j + 4 and norm(aligned[k].word) != rn:
            k += 1
        if k < len(aligned) and norm(aligned[k].word) == rn:
            aw = aligned[k]
            out_words[i] = {"word": rw, "start": round(float(aw.start), 3), "end": round(float(aw.end), 3),
                            "score": round(float(getattr(aw, "probability", 0.0) or 0.0), 3)}
            j = k + 1
        elif j < len(aligned):
            aw = aligned[j]  # positional fallback
            out_words[i] = {"word": rw, "start": round(float(aw.start), 3), "end": round(float(aw.end), 3), "score": 0.0}
            j += 1

    # Fill any unmatched words with a zero-length span at the previous end (keeps order monotonic).
    last_end = 0.0
    for i, w in enumerate(out_words):
        if w is None:
            out_words[i] = {"word": raw_words[i], "start": round(last_end, 3), "end": round(last_end, 3), "score": 0.0}
        last_end = out_words[i]["end"]

    # ── Update the TRANSCRIPTION in place (identical to the MMS path so downstream is unchanged) ──
    orig_words = tr.get("words", [])
    for s in tr.get("sentences", []):
        lo, hi = s.get("start", 0), s.get("end", 0)
        members = [i for i, w in enumerate(orig_words)
                   if (w.get("start", -1) >= lo - 0.05 and w.get("end", -1) <= hi + 0.05)]
        if members:
            s["start"] = out_words[members[0]]["start"]
            s["end"] = out_words[members[-1]]["end"]
    for i, w in enumerate(orig_words):
        if i < len(out_words):
            w["start"] = out_words[i]["start"]
            w["end"] = out_words[i]["end"]
    tr["_aligned"] = "stable_ts"

    gemini_bak = tr_path.replace(".json", ".gemini.json")
    if not os.path.exists(gemini_bak):
        import shutil
        shutil.copyfile(tr_path, gemini_bak)
    json.dump(tr, open(tr_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    json.dump({"language": lang, "words": out_words, "aligned": True,
               "detector": "stable_ts", "model": f"whisper-{model_name}"},
              open(out_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"aligned {len(out_words)} words (detector=stable_ts, whisper-{model_name})")
    for w in out_words[:3] + out_words[-2:]:
        print(f"   {w['start']:.3f}-{w['end']:.3f}  {w['word']}")


if __name__ == "__main__":
    main()
