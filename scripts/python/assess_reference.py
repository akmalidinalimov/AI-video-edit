"""
assess_reference.py (v2) — deterministic, face-anchored reference Layout Map +
Principle-4 overlay.

Per SCENE (given cut boundaries) it:
  - samples N frames inside the scene (avoiding transitions),
  - runs YuNet, takes the MEDIAN dominant-face box (multi-frame median, Rule 5),
  - decides A-roll PRESENT by persistence (a large face in >= half the frames),
  - classifies layout TYPE: fullscreen_aroll | top_split | bottom_split | broll_only,
  - detects the split DIVIDER row (strong horizontal edge near mid-canvas),
  - computes A-roll band + B-roll region in NORMALIZED [0,1] coords,
  - draws the bands + face box + divider + label onto the scene's mid frame.

Emits layout-map.json (normalized) + annotated frames.

Usage:
  python assess_reference.py <video> <out_dir> <cut0,cut1,...,cutN>   # boundaries incl. 0 and duration
"""
import sys, os, json
import cv2
import numpy as np

N_SAMPLES = 5
FACE_MIN_H = 0.10      # face height frac to count as a "real" face
PERSIST_MIN = 0.5      # fraction of sampled frames that must show a large face
FULLSCREEN_FACE_H = 0.40  # median face height frac >= this => fullscreen talking head


def median_box(boxes):
    a = np.array(boxes, dtype=float)
    return [float(np.median(a[:, i])) for i in range(4)]


def detect_divider(gray, lo=0.34, hi=0.66):
    """Strongest horizontal edge row in the middle band → the split line."""
    h = gray.shape[0]
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    rowstr = gy.mean(axis=1)
    a, b = int(h * lo), int(h * hi)
    band = rowstr[a:b]
    if band.size == 0:
        return 0.5
    return (a + int(np.argmax(band))) / h


def main():
    video, out_dir, boundsArg = sys.argv[1], sys.argv[2], sys.argv[3]
    bounds = [float(x) for x in boundsArg.split(",") if x.strip()]
    os.makedirs(out_dir, exist_ok=True)
    model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(f"ERROR cannot open {video}", file=sys.stderr); sys.exit(2)
    det = cv2.FaceDetectorYN.create(model, "", (320, 320), score_threshold=0.6)

    states = []
    for si in range(len(bounds) - 1):
        s0, s1 = bounds[si], bounds[si + 1]
        dur = s1 - s0
        # sample inside the scene, away from the 12% transition margins
        ts = [s0 + dur * (0.12 + 0.76 * k / max(1, N_SAMPLES - 1)) for k in range(N_SAMPLES)]
        mid_t = s0 + dur / 2.0
        face_boxes = []
        W = H = None
        mid_frame = None
        for j, t in enumerate(ts):
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue
            H, W = frame.shape[:2]
            if j == N_SAMPLES // 2:
                mid_frame = frame.copy()
            det.setInputSize((W, H))
            _, faces = det.detect(frame)
            if faces is not None and len(faces):
                f = max(faces, key=lambda r: r[2] * r[3])
                if (f[3] / H) >= FACE_MIN_H:
                    face_boxes.append([float(f[0]), float(f[1]), float(f[2]), float(f[3])])
        if mid_frame is None:
            cap.set(cv2.CAP_PROP_POS_MSEC, mid_t * 1000.0)
            ok, mid_frame = cap.read()
            if not ok:
                continue
            H, W = mid_frame.shape[:2]

        persist = len(face_boxes) / float(N_SAMPLES)
        aroll = None
        if persist >= PERSIST_MIN:
            fx, fy, fw, fh = median_box(face_boxes)
            cx, cy = fx + fw / 2.0, fy + fh / 2.0
            fhF = fh / H
            if fhF >= FULLSCREEN_FACE_H:
                ltype = "fullscreen_aroll"
                band = [0.0, 0.0, 1.0, 1.0]
                broll = None
            else:
                divider = detect_divider(cv2.cvtColor(mid_frame, cv2.COLOR_BGR2GRAY))
                if cy < H / 2.0:
                    ltype = "top_split"
                    band = [0.0, 0.0, 1.0, divider]
                    broll = [0.0, divider, 1.0, 1.0 - divider]
                else:
                    ltype = "bottom_split"
                    band = [0.0, divider, 1.0, 1.0 - divider]
                    broll = [0.0, 0.0, 1.0, divider]
            aroll = {
                "type": ltype,
                "faceBoxNorm": [fx / W, fy / H, fw / W, fh / H],
                "centerNorm": [cx / W, cy / H],
                "faceHeightFrac": round(fhF, 4),
                "bandNorm": [round(v, 4) for v in band],
                "persistence": round(persist, 2),
            }
            broll_region = broll
        else:
            ltype = "broll_only"
            broll_region = [0.0, 0.0, 1.0, 1.0]

        states.append({
            "index": si, "timeRange": [round(s0, 2), round(s1, 2)], "midTime": round(mid_t, 2),
            "canvas": [W, H], "type": ltype, "aroll": aroll,
            "brollNorm": [round(v, 4) for v in broll_region] if broll_region else None,
        })

        # ── overlay ──
        f = mid_frame
        if aroll:
            bx = [int(band[0] * W), int(band[1] * H), int(band[2] * W), int(band[3] * H)]
            cv2.rectangle(f, (bx[0], bx[1]), (bx[0] + bx[2], bx[1] + bx[3]), (0, 220, 0), 5)  # A-roll band green
            fb = aroll["faceBoxNorm"]
            cv2.rectangle(f, (int(fb[0] * W), int(fb[1] * H)), (int((fb[0] + fb[2]) * W), int((fb[1] + fb[3]) * H)), (0, 255, 255), 2)  # face yellow
            if broll_region:
                rb = [int(broll_region[0] * W), int(broll_region[1] * H), int(broll_region[2] * W), int(broll_region[3] * H)]
                cv2.rectangle(f, (rb[0], rb[1]), (rb[0] + rb[2], rb[1] + rb[3]), (0, 0, 235), 5)  # B-roll red
            col = (0, 220, 0)
        else:
            cv2.rectangle(f, (4, 4), (W - 4, H - 4), (0, 0, 235), 6)
            col = (0, 0, 235)
        cv2.putText(f, f"{ltype}  p={persist:.1f}", (24, 64), cv2.FONT_HERSHEY_SIMPLEX, 1.2, col, 3, cv2.LINE_AA)
        cv2.putText(f, f"[{s0:.1f}-{s1:.1f}]s", (24, H - 36), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 3, cv2.LINE_AA)
        cv2.imwrite(os.path.join(out_dir, f"scene_{si:02d}.png"), f)

    cap.release()
    canvas = states[0]["canvas"] if states else None
    json.dump({"video": video, "canvas": canvas, "states": states},
              open(os.path.join(out_dir, "layout-map.json"), "w"), indent=2)
    from collections import Counter
    dist = Counter(s["type"] for s in states)
    print(f"layout map: {len(states)} scenes -> {out_dir}")
    print("types: " + ", ".join(f"{k}={v}" for k, v in dist.items()))


if __name__ == "__main__":
    main()
