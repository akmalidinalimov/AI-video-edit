"""
MediaPipe face + shoulder detection for A-roll crop geometry.

Replaces the brittle brightness-based detectFaceRegion. Samples N frames
across the clip, runs MediaPipe FaceDetection (head box) + Pose (shoulders),
takes the multi-frame median, and emits the SAME JSON schema the render code
already consumes — plus a `shoulderY` and full-head `topY` (incl. hair/hijab).

Usage:
  python detect_face.py <video_path> <out_json> [--samples 15]

Output JSON (normalized 0-1 ratios + pixel values):
{
  "median":       { "centerX", "centerY", "topY", "height" },
  "medianPixels": { "centerX", "centerY", "topY", "faceHeight", "shoulderY" },
  "srcWidth", "srcHeight", "samplesUsed", "detector": "mediapipe"
}
  topY      = TOP OF HEAD (face box extended up for hair/forehead/hijab)
  height    = face box height (browline->chin), the detected face span
  shoulderY = shoulder line (from Pose), or estimated if pose missing
"""
import sys
import json
import statistics
import cv2
import mediapipe as mp

mp_face = mp.solutions.face_detection
mp_pose = mp.solutions.pose

# Fraction of face-box height added ABOVE the box to reach true head top
# (MediaPipe's face box starts ~browline; hair/forehead/hijab sits above).
HEAD_EXTEND = 0.55


def detect(video_path, samples):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {video_path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Sample evenly across the middle 80% (skip very start/end).
    if total > 0:
        idxs = [int(total * (0.1 + 0.8 * i / max(1, samples - 1))) for i in range(samples)]
    else:
        idxs = list(range(samples))

    rows = []
    with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.5) as fd, \
         mp_pose.Pose(static_image_mode=True, model_complexity=1,
                      min_detection_confidence=0.5) as pose:
        for fi in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
            ok, frame = cap.read()
            if not ok:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            fres = fd.process(rgb)
            if not fres.detections:
                continue
            # Largest face (closest speaker).
            best = max(fres.detections,
                       key=lambda d: d.location_data.relative_bounding_box.height)
            box = best.location_data.relative_bounding_box
            face_top = box.ymin
            face_h = box.height
            face_cx = box.xmin + box.width / 2.0
            face_cy = box.ymin + box.height / 2.0
            head_top = max(0.0, face_top - face_h * HEAD_EXTEND)

            # Shoulders via Pose (landmarks 11 = left, 12 = right shoulder).
            shoulder_y = None
            pres = pose.process(rgb)
            if pres.pose_landmarks:
                lm = pres.pose_landmarks.landmark
                ys = [lm[11].y, lm[12].y]
                vis = [lm[11].visibility, lm[12].visibility]
                if min(vis) > 0.3:
                    shoulder_y = sum(ys) / 2.0
            if shoulder_y is None:
                # Estimate: shoulders ~1.6 face-heights below the face-box top.
                shoulder_y = min(1.0, face_top + face_h * 1.6)

            rows.append({
                "centerX": face_cx, "centerY": face_cy,
                "topY": head_top, "height": face_h, "shoulderY": shoulder_y,
            })

    cap.release()
    if not rows:
        raise SystemExit("no face detected in any sampled frame")

    def med(key):
        return statistics.median(r[key] for r in rows)

    m = {k: round(med(k), 4) for k in ("centerX", "centerY", "topY", "height")}
    shoulder = round(med("shoulderY"), 4)
    return {
        "median": m,
        "medianPixels": {
            "centerX": round(m["centerX"] * w),
            "centerY": round(m["centerY"] * h),
            "topY": round(m["topY"] * h),
            "faceHeight": round(m["height"] * h),
            "shoulderY": round(shoulder * h),
        },
        "shoulderY": shoulder,
        "srcWidth": w, "srcHeight": h,
        "samplesUsed": len(rows),
        "detector": "mediapipe",
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: detect_face.py <video> <out_json> [--samples N]")
    video, out = sys.argv[1], sys.argv[2]
    samples = 15
    if "--samples" in sys.argv:
        samples = int(sys.argv[sys.argv.index("--samples") + 1])
    result = detect(video, samples)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
