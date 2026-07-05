"""Detect ALL faces in an image (YuNet) — for crop QA (multi-person A-roll,
B-roll face-cut checks). Prints JSON: every face box + normalized center + height."""
import sys, os, json
import cv2

img_path = sys.argv[1]
model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
frame = cv2.imread(img_path)
if frame is None:
    print(json.dumps({"error": f"cannot read {img_path}"})); sys.exit(1)
h, w = frame.shape[:2]
det = cv2.FaceDetectorYN.create(model, "", (w, h), score_threshold=0.55)
det.setInputSize((w, h))
_, faces = det.detect(frame)
out = []
if faces is not None:
    for f in faces:
        out.append({
            "x": round(float(f[0]), 1), "y": round(float(f[1]), 1),
            "w": round(float(f[2]), 1), "h": round(float(f[3]), 1),
            "score": round(float(f[-1]), 2),
            "cxN": round(float((f[0] + f[2] / 2) / w), 3),
            "cyN": round(float((f[1] + f[3] / 2) / h), 3),
            "hFrac": round(float(f[3] / h), 3),
        })
out.sort(key=lambda d: d["w"] * d["h"], reverse=True)
print(json.dumps({"img": os.path.basename(img_path), "canvas": [w, h], "nFaces": len(out), "faces": out}, indent=2))
