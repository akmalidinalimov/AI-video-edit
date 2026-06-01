"""
WhisperX transcription with word-level forced alignment.

Produces accurate per-WORD [start,end] timecodes (wav2vec2 alignment) — the
piece Gemini lacked. Used to find the TRUE onset of speech (kills the leading
pause) and exact sentence boundaries for trimming.

Run with the whisperx venv:
  scripts/python/.venv/Scripts/python.exe scripts/python/transcribe_whisperx.py \
      <audio_or_video> <out_json> [--model small] [--lang uz]

Output JSON:
{
  "language": "uz",
  "duration": 21.2,
  "words":     [ { "word", "start", "end", "score" }, ... ],
  "segments":  [ { "start", "end", "text" }, ... ],
  "model": "small", "aligned": true|false
}
"""
import sys
import json
import gc

import whisperx

DEVICE = "cpu"
COMPUTE = "int8"  # CPU-friendly; use "float16" on GPU


def transcribe(media, model_name, lang):
    audio = whisperx.load_audio(media)
    duration = round(len(audio) / 16000.0, 3)

    model = whisperx.load_model(model_name, DEVICE, compute_type=COMPUTE, language=lang)
    result = model.transcribe(audio, batch_size=16)
    detected_lang = result.get("language", lang or "unknown")
    del model
    gc.collect()

    aligned = False
    words = []
    try:
        amodel, meta = whisperx.load_align_model(language_code=detected_lang, device=DEVICE)
        ares = whisperx.align(result["segments"], amodel, meta, audio, DEVICE,
                              return_char_alignments=False)
        for seg in ares.get("segments", []):
            for w in seg.get("words", []):
                if "start" in w and "end" in w:
                    words.append({"word": w.get("word", "").strip(),
                                  "start": round(w["start"], 3), "end": round(w["end"], 3),
                                  "score": round(w.get("score", 0.0), 3)})
        segments = [{"start": round(s["start"], 3), "end": round(s["end"], 3),
                     "text": s.get("text", "").strip()}
                    for s in ares.get("segments", []) if "start" in s]
        aligned = True
        del amodel
        gc.collect()
    except Exception as e:
        sys.stderr.write(f"[align fallback] {e}\n")
        segments = [{"start": round(s["start"], 3), "end": round(s["end"], 3),
                     "text": s.get("text", "").strip()}
                    for s in result["segments"] if "start" in s]
        for s in result["segments"]:
            if "start" in s and "end" in s:
                words.append({"word": s.get("text", "").strip(),
                              "start": round(s["start"], 3), "end": round(s["end"], 3),
                              "score": 0.0})

    return {"language": detected_lang, "duration": duration, "words": words,
            "segments": segments, "model": model_name, "aligned": aligned}


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: transcribe_whisperx.py <media> <out_json> [--model small] [--lang uz]")
    media, out = sys.argv[1], sys.argv[2]
    model_name = "small"
    lang = None
    if "--model" in sys.argv:
        model_name = sys.argv[sys.argv.index("--model") + 1]
    if "--lang" in sys.argv:
        lang = sys.argv[sys.argv.index("--lang") + 1]

    result = transcribe(media, model_name, lang)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"language={result['language']} aligned={result['aligned']} "
          f"words={len(result['words'])} segments={len(result['segments'])} "
          f"duration={result['duration']}s")


if __name__ == "__main__":
    main()
