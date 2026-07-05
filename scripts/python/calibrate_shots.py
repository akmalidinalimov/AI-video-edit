"""
calibrate_shots.py — Phase 0: establish a TRUSTED shot count for a reference so the pacing
metric isn't scored against a noisy detector. Compares three independent shot detectors on the
B-roll band:
  1. PySceneDetect ContentDetector (industry standard, BSD-3) — the TRUSTED reference
  2. PySceneDetect AdaptiveDetector (handles fast motion better)
  3. FFmpeg scene>thr (what the accuracy anchor currently uses)
and prints counts + boundaries so we can pick the right thresholds.

Usage: calibrate_shots.py <video> <arollSide top|bottom> <dividerFraction>
"""
import sys, os, tempfile, subprocess
import cv2
from scenedetect import detect, ContentDetector, AdaptiveDetector

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.join(HERE, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")


def broll_crop(video, side, divider):
    """ffmpeg crop filter isolating the B-roll band (opposite the A-roll)."""
    cap = cv2.VideoCapture(video)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    if divider is None or divider <= 0:
        return f"crop={w}:{h}:0:0", (w, h)
    if side == "bottom":  # A-roll bottom → B-roll top
        return f"crop={w}:{max(2, round(divider * h))}:0:0", (w, round(divider * h))
    else:                 # A-roll top → B-roll bottom
        return f"crop={w}:{max(2, round((1 - divider) * h))}:0:{round(divider * h)}", (w, round((1 - divider) * h))


def ffmpeg_scene(video, crop, thr):
    r = subprocess.run([FFMPEG, "-i", video, "-vf", f"{crop},select='gt(scene,{thr})',showinfo", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    import re
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", r.stderr + r.stdout)]


def main():
    video = sys.argv[1]
    side = sys.argv[2] if len(sys.argv) > 2 else "bottom"
    divider = float(sys.argv[3]) if len(sys.argv) > 3 else 0.561
    crop, (cw, ch) = broll_crop(video, side, divider)
    print(f"B-roll band crop: {crop} ({cw}x{ch})\n")

    # crop the B-roll band to a temp clip so PySceneDetect sees the same domain the analyzer does
    tmp = os.path.join(tempfile.gettempdir(), "calib_broll.mp4")
    subprocess.run([FFMPEG, "-y", "-i", video, "-vf", crop, "-an", tmp], capture_output=True, text=True)

    # 1. ContentDetector (TRUSTED) at a few thresholds
    print("PySceneDetect ContentDetector (trusted):")
    content_counts = {}
    for thr in (27, 30, 35, 40):
        scenes = detect(tmp, ContentDetector(threshold=thr))
        content_counts[thr] = len(scenes)
        cuts = [round(s[0].get_seconds(), 2) for s in scenes[1:]]  # internal boundaries
        print(f"  thr={thr}: {len(scenes)} shots ({len(cuts)} cuts) {cuts[:14]}")

    # 2. AdaptiveDetector (robust to fast motion)
    print("\nPySceneDetect AdaptiveDetector:")
    scenes = detect(tmp, AdaptiveDetector())
    acuts = [round(s[0].get_seconds(), 2) for s in scenes[1:]]
    print(f"  {len(scenes)} shots ({len(acuts)} cuts) {acuts[:14]}")

    # 3. FFmpeg scene at a few thresholds (the current anchor)
    print("\nFFmpeg scene>thr (current anchor):")
    for thr in (0.3, 0.4, 0.5, 0.6):
        cuts = ffmpeg_scene(video, crop, thr)
        print(f"  thr={thr}: {len(cuts)} cuts")

    try: os.remove(tmp)
    except OSError: pass

    # recommendation: the trusted content-shot count is the median of ContentDetector thresholds
    trusted = sorted(content_counts.values())[len(content_counts) // 2]
    print(f"\nTRUSTED content-shot count (ContentDetector median): {trusted}")


if __name__ == "__main__":
    main()
