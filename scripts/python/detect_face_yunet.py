"""
OpenCV YuNet (DNN) face detection for A-roll crop geometry.

Replaces the brittle brightness-based guesser (and the broken MediaPipe build).
Samples N frames across the clip, runs cv2.FaceDetectorYN (a real DNN face
detector), takes the multi-frame median box, and emits the SAME clip_N_face.json
schema the renderer already consumes.

Why this fixes the per-clip-inconsistent framing: the brightness guesser returned
a *different wrong* face box per clip (height 0.13-0.14, topY 0.24-0.27). YuNet
returns an accurate, consistent face box for every clip, so the single crop
formula frames all segments identically.

Usage:
  scripts/python/.venv-vision/Scripts/python.exe \
      scripts/python/detect_face_yunet.py <video> <out_json> \
      [--samples 15] [--region x,y,w,h]

  --region   optional crop (source pixels) applied to every sampled frame BEFORE
             detection — used to measure the face INSIDE the reference circle.
             Output ratios/pixels are then relative to that region.

Output JSON (normalized 0-1 ratios + pixel values), matching the renderer:
{
  "median":       { "centerX", "centerY", "topY", "height" },
  "medianPixels": { "centerX", "centerY", "topY", "faceHeight" },
  "srcWidth", "srcHeight", "samplesUsed", "detector": "yunet", ...
}
  topY   = RAW YuNet face-box top (forehead/eyebrow line) as a ratio. We store the
           ACCURATE measured value, NOT a guessed head extension — the renderer
           positions the crop by matching the reference's measured face fractions
           (which already account for the head/hijab), so no fragile per-subject
           head-extension constant is baked into the data.
  height = YuNet face box height (the detected face span). True ~0.22-0.26 of
           frame for these tight portrait A-rolls, vs brightness's wrong 0.13.
  headTopY (separate field) = an OPTIONAL extended-head estimate for the stacked
           layout, kept out of `median` so the circle path stays extension-free.
"""
import os
import sys
import json
import statistics
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")

# Fraction of YuNet face-box height added ABOVE the box to estimate the true head
# top, used ONLY for the optional `headTopY` field (stacked layout). For these
# fitted-hijab subjects the head sits just above the box, so this is small.
# The circle path does NOT use this — it matches the reference's measured face
# fractions instead.
HEAD_EXTEND = 0.18

SCORE_THRESHOLD = 0.6


def _parse_region(arg):
    if not arg:
        return None
    parts = [int(round(float(v))) for v in arg.split(",")]
    if len(parts) != 4:
        raise SystemExit("--region must be x,y,w,h")
    return parts


def detect(video_path, samples, region=None):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {video_path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    full_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    full_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Detection frame dimensions (after optional region crop).
    if region:
        rx, ry, rw, rh = region
        det_w, det_h = rw, rh
    else:
        det_w, det_h = full_w, full_h

    detector = cv2.FaceDetectorYN.create(
        MODEL, "", (det_w, det_h),
        score_threshold=SCORE_THRESHOLD, nms_threshold=0.3, top_k=5000,
    )

    # Sample evenly across the middle 80% (skip very start/end).
    if total > 0:
        idxs = [int(total * (0.1 + 0.8 * i / max(1, samples - 1))) for i in range(samples)]
    else:
        idxs = list(range(samples))

    rows = []
    for fi in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, frame = cap.read()
        if not ok:
            continue
        if region:
            rx, ry, rw, rh = region
            frame = frame[ry:ry + rh, rx:rx + rw]
            if frame.shape[0] != rh or frame.shape[1] != rw:
                continue

        detector.setInputSize((frame.shape[1], frame.shape[0]))
        retval, faces = detector.detect(frame)
        if faces is None or len(faces) == 0:
            continue
        # Largest face (closest speaker) — by box height.
        best = max(faces, key=lambda f: f[3])
        fx, fy, fw, fh = float(best[0]), float(best[1]), float(best[2]), float(best[3])
        score = float(best[14])

        # Normalize to the detection frame.
        face_top = fy / det_h
        face_h = fh / det_h
        face_cx = (fx + fw / 2.0) / det_w
        face_cy = (fy + fh / 2.0) / det_h
        head_top = max(0.0, face_top - face_h * HEAD_EXTEND)

        rows.append({
            "centerX": face_cx, "centerY": face_cy,
            "headTopY": head_top, "faceTopY": face_top, "height": face_h,
            "score": score, "frame": fi,
        })

    cap.release()
    if not rows:
        raise SystemExit("no face detected in any sampled frame")

    def med(key):
        return statistics.median(r[key] for r in rows)

    m = {
        "centerX": round(med("centerX"), 4),
        "centerY": round(med("centerY"), 4),
        "topY": round(med("faceTopY"), 4),    # RAW face box top — renderer reads this
        "height": round(med("height"), 4),    # YuNet face box height
    }
    head_top_y = round(med("headTopY"), 4)    # extended head-top estimate (stack only)

    return {
        "median": m,
        "medianPixels": {
            "centerX": round(m["centerX"] * det_w),
            "centerY": round(m["centerY"] * det_h),
            "topY": round(m["topY"] * det_h),
            "faceHeight": round(m["height"] * det_h),
        },
        "headTopY": head_top_y,
        "headExtend": HEAD_EXTEND,
        "srcWidth": det_w, "srcHeight": det_h,
        "fullWidth": full_w, "fullHeight": full_h,
        "region": region,
        "samplesUsed": len(rows),
        "samples": rows,
        "detector": "yunet",
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: detect_face_yunet.py <video> <out_json> "
                         "[--samples N] [--region x,y,w,h]")
    video, out = sys.argv[1], sys.argv[2]
    samples = 15
    region = None
    if "--samples" in sys.argv:
        samples = int(sys.argv[sys.argv.index("--samples") + 1])
    if "--region" in sys.argv:
        region = _parse_region(sys.argv[sys.argv.index("--region") + 1])

    result = detect(video, samples, region)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    # Compact console summary.
    m = result["median"]
    print(f"detector=yunet samplesUsed={result['samplesUsed']} "
          f"center=({m['centerX']},{m['centerY']}) faceTopY={m['topY']} "
          f"headTopY={result['headTopY']} faceHeight={m['height']} "
          f"(px {result['medianPixels']['faceHeight']})")


if __name__ == "__main__":
    main()
