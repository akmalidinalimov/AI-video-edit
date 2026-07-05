"""
detect_aroll_group.py — A-roll multi-speaker GROUP box (YuNet), median over N
frames. Returns the bounding box that contains ALL faces so the crop can frame
EVERYONE (not just the largest face). Also returns the tallest single-face height
(for single-person sizing fallback).

Usage: python detect_aroll_group.py <video> <out.json> [--samples N]
Output: {found, srcWidth, srcHeight, centerX, centerY, width, height, faceHeight, nFaces}
  (centerX/Y/width/height/faceHeight are fractions of the source)
"""
import sys, os, json
import cv2
import numpy as np

video = sys.argv[1]
out_json = sys.argv[2]
samples = 15
if "--samples" in sys.argv:
    samples = int(sys.argv[sys.argv.index("--samples") + 1])

model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
cap = cv2.VideoCapture(video)
if not cap.isOpened():
    json.dump({"found": False, "error": "open"}, open(out_json, "w")); sys.exit(0)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
det = cv2.FaceDetectorYN.create(model, "", (W, H), score_threshold=0.6)
det.setInputSize((W, H))

groups = []      # per-frame [x0,y0,x1,y1] over ALL faces
maxFaceH = []    # tallest face height per frame
nfaces = []
for i in range(samples):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(((i + 0.5) / samples) * nframes))
    ok, frame = cap.read()
    if not ok:
        continue
    _, faces = det.detect(frame)
    if faces is None or len(faces) == 0:
        continue
    x0 = min(float(f[0]) for f in faces)
    y0 = min(float(f[1]) for f in faces)
    x1 = max(float(f[0] + f[2]) for f in faces)
    y1 = max(float(f[1] + f[3]) for f in faces)
    groups.append([x0, y0, x1, y1])
    maxFaceH.append(max(float(f[3]) for f in faces))
    nfaces.append(len(faces))
cap.release()

if not groups:
    json.dump({"found": False}, open(out_json, "w")); sys.exit(0)

g = np.median(np.array(groups), axis=0)
cx = (g[0] + g[2]) / 2.0
cy = (g[1] + g[3]) / 2.0
gw = g[2] - g[0]
gh = g[3] - g[1]
json.dump({
    "found": True, "srcWidth": W, "srcHeight": H,
    "centerX": round(cx / W, 4), "centerY": round(cy / H, 4),
    "width": round(gw / W, 4), "height": round(gh / H, 4),
    "faceHeight": round(float(np.median(maxFaceH)) / H, 4),
    "nFaces": int(round(float(np.median(nfaces)))),
}, open(out_json, "w"), indent=2)
print(f"group: nFaces={int(round(float(np.median(nfaces))))} center=({cx/W:.3f},{cy/H:.3f}) width={gw/W:.3f}")
