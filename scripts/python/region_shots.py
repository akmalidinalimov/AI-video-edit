"""
region_shots.py — shots INSIDE a horizontal band (for multi-region layouts).

The whole-frame shot detector under-counts a stacked composite (the static A-roll + title
dilute the B-roll's cuts). Given a band [yStart, yEnd] (fractions), crop to it and run
PySceneDetect ContentDetector — so a B-roll window's true cut rhythm is measured, not the reel's.

Usage: region_shots.py <video> <yStartFrac> <yEndFrac>  →  JSON {shots, cuts, duration}
"""
import sys, os, json, tempfile, subprocess
import cv2
from scenedetect import detect, ContentDetector

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.join(HERE, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")


def main():
    video = sys.argv[1]
    y0f = max(0.0, min(1.0, float(sys.argv[2])))
    y1f = max(0.0, min(1.0, float(sys.argv[3])))
    cap = cv2.VideoCapture(video)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.release()
    dur = total / fps if fps else 0
    y0 = int(round(y0f * h)); ch = max(2, int(round(y1f * h)) - y0)
    scale = ",scale=384:-2" if w > 384 else ""
    tmp = os.path.join(tempfile.gettempdir(), f"region_{os.getpid()}.mp4")
    try:
        r = subprocess.run([FFMPEG, "-y", "-i", video, "-vf", f"crop={w}:{ch}:0:{y0}{scale}",
                            "-an", "-preset", "ultrafast", tmp], capture_output=True, text=True, timeout=180)
        if r.returncode != 0 or not os.path.exists(tmp):
            print(json.dumps({"shots": 0, "cuts": [], "duration": round(dur, 2), "error": "ffmpeg"})); return
        scenes = detect(tmp, ContentDetector(threshold=27))
        cuts = [round(s[0].get_seconds(), 2) for s in scenes[1:]]
        print(json.dumps({"shots": len(scenes), "cuts": cuts, "duration": round(dur, 2)}))
    finally:
        try: os.remove(tmp)
        except OSError: pass


if __name__ == "__main__":
    main()
