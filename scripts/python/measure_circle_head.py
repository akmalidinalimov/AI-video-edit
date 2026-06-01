"""
Measure the speaker's face/head box INSIDE the rendered circle PIP, across many
frames, so the closed loop can verify the head is fully inside with a TOP GAP and
the chin/shoulders are not clipped.

Usage:
  python measure_circle_head.py <video> <circle x,y,w,h> <t0,t1,...> <out_json>

Output JSON:
{
  "diameter": 428,
  "frames": [ { "t", "detected", "faceTopFrac", "faceBottomFrac", "faceFrac",
                "centerXFrac", "headTopFrac" }, ... ],
  "summary": { "minFaceTopFrac", "maxFaceBottomFrac", "medFaceFrac", "detectedRatio" }
}
  faceTopFrac    = face-box top / diameter      (bigger = more gap above the face)
  faceBottomFrac = face-box bottom / diameter   (smaller = more room for chin/shoulders)
  headTopFrac    = estimated hijab/head top / diameter (face top minus HEAD_EXTEND*faceH)
"""
import os
import sys
import json
import statistics
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")
HEAD_EXTEND = 0.12  # fitted-hijab subjects: head sits just above the YuNet box


def main():
    if len(sys.argv) < 5:
        raise SystemExit("usage: measure_circle_head.py <video> <x,y,w,h> <t0,t1,...> <out_json>")
    video = sys.argv[1]
    x, y, w, h = [int(round(float(v))) for v in sys.argv[2].split(",")]
    times = [float(t) for t in sys.argv[3].split(",") if t != ""]
    out = sys.argv[4]

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {video}")
    det = cv2.FaceDetectorYN.create(MODEL, "", (w, h), score_threshold=0.5,
                                    nms_threshold=0.3, top_k=5000)

    frames = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            frames.append({"t": round(t, 3), "detected": False})
            continue
        circ = frame[y:y + h, x:x + w]
        if circ.shape[0] != h or circ.shape[1] != w:
            frames.append({"t": round(t, 3), "detected": False})
            continue
        det.setInputSize((w, h))
        rv, faces = det.detect(circ)
        if faces is None or len(faces) == 0:
            frames.append({"t": round(t, 3), "detected": False})
            continue
        f = max(faces, key=lambda r: r[3])
        fx, fy, fw, fh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
        frames.append({
            "t": round(t, 3), "detected": True,
            "faceTopFrac": round(fy / h, 4),
            "faceBottomFrac": round((fy + fh) / h, 4),
            "faceFrac": round(fh / h, 4),
            "centerXFrac": round((fx + fw / 2.0) / w, 4),
            "headTopFrac": round(max(0.0, fy - fh * HEAD_EXTEND) / h, 4),
        })
    cap.release()

    det_frames = [f for f in frames if f.get("detected")]
    summary = {
        "detectedRatio": round(len(det_frames) / max(1, len(frames)), 3),
        "minFaceTopFrac": round(min((f["faceTopFrac"] for f in det_frames), default=0), 4),
        "minHeadTopFrac": round(min((f["headTopFrac"] for f in det_frames), default=0), 4),
        "maxFaceBottomFrac": round(max((f["faceBottomFrac"] for f in det_frames), default=1), 4),
        "medFaceFrac": round(statistics.median([f["faceFrac"] for f in det_frames]) if det_frames else 0, 4),
    }
    with open(out, "w", encoding="utf-8") as fp:
        json.dump({"diameter": h, "frames": frames, "summary": summary}, fp, indent=2)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
