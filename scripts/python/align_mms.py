"""
MMS forced alignment — PRECISE per-word timestamps for the A-roll.

Gemini gives the WORDS (good Uzbek text) but its per-word TIMESTAMPS drift
~300-1000ms, which makes trims clip words. Forced alignment pins each known word
to the audio, giving accurate boundaries. Uses torchaudio's MMS_FA aligner
(1100+ languages incl. Uzbek). The ~1GB model is cached under scripts/python/.torch
(downloaded once via PowerShell, past the SSL proxy).

Usage:
  scripts/python/.venv/Scripts/python.exe scripts/python/align_mms.py \
      <audio_or_video> <transcription_json> <out_words_json>

  <transcription_json> = clip_N_transcription.json (reads .words[].word in order).
  <out_words_json>     = clip_N_words.json (written with precise times, detector:"mms").

Side effects (the trim pipeline reads word/sentence TIMES from the transcription):
  - clip_N_transcription.json is UPDATED in place: every word's start/end is
    replaced with the MMS-aligned time, and each sentence's start/end is re-derived
    from its (now precise) first/last word. Original is backed up once as
    clip_N_transcription.gemini.json.
  - clip_N_words.json is (re)written with the aligned words + detector:"mms".
"""
import os
import sys
import json
import re
import subprocess

# Make torch find the cached MMS model (downloaded past the proxy).
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("TORCH_HOME", os.path.join(HERE, ".torch"))

import torch
import torchaudio
from torchaudio.pipelines import MMS_FA as bundle

FFMPEG = os.path.join(HERE, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")

# The MMS_FA character inventory (lowercase Latin + apostrophe). We romanize each
# Uzbek word into this set: curly apostrophes -> "'", drop anything else.
ALLOWED = set("abcdefghijklmnopqrstuvwxyz'")


def normalize_word(w):
    w = w.strip().lower()
    w = w.replace("ʻ", "'").replace("ʼ", "'").replace("‘", "'").replace("’", "'").replace("`", "'")
    w = re.sub(r"[^a-z']", "", w)   # drop punctuation, digits, accents
    return w


def load_audio(path, sr):
    # Decode to mono PCM at the model sample rate via ffmpeg (robust to .MOV).
    p = subprocess.run(
        [FFMPEG, "-i", path, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-loglevel", "error", "pipe:1"],
        capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise SystemExit(f"ffmpeg failed for {path}: {p.stderr[:200]}")
    import numpy as np
    a = np.frombuffer(p.stdout, dtype=np.int16).astype("float32") / 32768.0
    return torch.from_numpy(a).unsqueeze(0)


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: align_mms.py <audio> <transcription_json> <out_words_json>")
    audio_path, tr_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    tr = json.load(open(tr_path, encoding="utf-8"))
    raw_words = [w.get("word", "") for w in tr.get("words", [])]
    if not raw_words:
        raise SystemExit("no words in transcription")

    # Normalize; keep a map from kept-index -> original-index (skip empties).
    norm, keep_idx = [], []
    for i, w in enumerate(raw_words):
        n = normalize_word(w)
        if n:
            norm.append(n)
            keep_idx.append(i)

    sr = bundle.sample_rate
    model = bundle.get_model()
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()

    waveform = load_audio(audio_path, sr)
    with torch.inference_mode():
        emission, _ = model(waveform)
        token_spans = aligner(emission[0], tokenizer(norm))

    num_frames = emission.size(1)
    ratio = waveform.size(1) / num_frames / sr  # seconds per emission frame

    # Build output aligned to the ORIGINAL word order; words that normalized to
    # empty inherit a zero-length span between neighbours (rare: pure punctuation).
    out_words = [None] * len(raw_words)
    for k, spans in enumerate(token_spans):
        oi = keep_idx[k]
        start = spans[0].start * ratio
        end = spans[-1].end * ratio
        score = sum(s.score for s in spans) / len(spans)
        out_words[oi] = {
            "word": raw_words[oi],
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "score": round(float(score), 3),
        }
    # Fill any skipped (empty-normalized) words with a tiny span at the previous end.
    last_end = 0.0
    for i, w in enumerate(out_words):
        if w is None:
            out_words[i] = {"word": raw_words[i], "start": round(last_end, 3),
                            "end": round(last_end, 3), "score": 0.0}
        last_end = out_words[i]["end"]

    # ── Update the TRANSCRIPTION in place (the trim pipeline reads times here) ──
    # Map each ORIGINAL Gemini word to a sentence (Gemini-internal consistency),
    # then set sentence start/end from the aligned times of its words.
    orig_words = tr.get("words", [])
    sentences = tr.get("sentences", [])
    for s in sentences:
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
    tr["_aligned"] = "mms"

    gemini_bak = tr_path.replace(".json", ".gemini.json")
    if not os.path.exists(gemini_bak):
        import shutil
        shutil.copyfile(tr_path, gemini_bak)
    json.dump(tr, open(tr_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    result = {
        "language": tr.get("language", "uz"),
        "duration": round(waveform.size(1) / sr, 3),
        "words": out_words,
        "aligned": True,
        "detector": "mms",
        "model": "MMS_FA",
    }
    json.dump(result, open(out_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"aligned {len(out_words)} words (detector=mms); updated {os.path.basename(tr_path)} + {os.path.basename(out_path)}")
    for w in out_words[:3] + out_words[-2:]:
        print(f"   {w['start']:.3f}-{w['end']:.3f}  {w['word']}")


if __name__ == "__main__":
    main()
