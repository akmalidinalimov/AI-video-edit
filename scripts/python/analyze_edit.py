"""
analyze_edit.py — first-pass editorial analysis of an edited reel: detect scene
cuts and build a labelled contact sheet so we can study the editing (A-roll vs
B-roll, layers, text, animation, transitions). Reusable as the basis for the
reference-broll-profiler.

Usage:
  python analyze_edit.py <video> <out_dir> [--interval 1.5] [--cut-thresh 0.45]
"""
import os, sys, json
import cv2
import numpy as np

def main():
    video = sys.argv[1]; out_dir = sys.argv[2]
    interval = float(sys.argv[sys.argv.index("--interval")+1]) if "--interval" in sys.argv else 1.5
    cut_thresh = float(sys.argv[sys.argv.index("--cut-thresh")+1]) if "--cut-thresh" in sys.argv else 0.45
    os.makedirs(out_dir, exist_ok=True)

    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W = int(cap.get(3)); H = int(cap.get(4))
    dur = n / fps

    # --- scene-cut detection via HSV-histogram correlation between sampled frames ---
    cuts = []
    prev_hist = None
    step = max(1, int(fps/6))  # ~6 samples/sec
    fi = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, fr = cap.read()
        if not ok: break
        hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv],[0,1],None,[50,60],[0,180,0,256])
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            corr = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if corr < (1 - cut_thresh):
                cuts.append(round(fi/fps, 2))
        prev_hist = hist
        fi += step
    # merge cuts closer than 0.4s
    merged = []
    for c in cuts:
        if not merged or c - merged[-1] > 0.4: merged.append(c)
    cuts = merged

    # --- contact sheet: frames every `interval` sec, labelled with timestamp ---
    times = list(np.arange(0.3, dur, interval))
    thumbs = []
    tw, th = 200, 356  # keep 9:16-ish thumbs
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, fr = cap.read()
        if not ok: continue
        thumb = cv2.resize(fr, (tw, th))
        cv2.rectangle(thumb,(0,0),(tw,22),(0,0,0),-1)
        cv2.putText(thumb, f"{t:.1f}s", (4,16), cv2.FONT_HERSHEY_SIMPLEX, 0.5,(0,255,255),1)
        thumbs.append(thumb)
    cols = 6
    rows = (len(thumbs)+cols-1)//cols
    sheet = np.zeros((rows*th, cols*tw, 3), dtype=np.uint8)
    for i,tm in enumerate(thumbs):
        r,c = divmod(i, cols)
        sheet[r*th:(r+1)*th, c*tw:(c+1)*tw] = tm
    cv2.imwrite(os.path.join(out_dir, "contact_sheet.jpg"), sheet)

    print(json.dumps({
        "video": os.path.basename(video), "res": f"{W}x{H}", "dur": round(dur,1),
        "fps": round(fps,1), "sceneCuts": cuts, "cutCount": len(cuts),
        "thumbs": len(thumbs), "interval": interval,
    }, indent=1))

if __name__ == "__main__":
    main()
