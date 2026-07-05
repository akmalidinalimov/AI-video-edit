"""
layout_analyzer.py — deterministic reference LAYOUT analysis (foundation: Stages 1-2 + self-verify).

Decomposes a reference video's SPATIAL layout from the pixels, fixing the A-roll/B-roll
side ambiguity that pure geometry can't resolve (a divider tells you WHERE the boundary
is, not WHICH half is the talking head). It fuses three signals:

  GEOMETRY  (OpenCV HoughLinesP + persistent horizontal-edge SEAM profile) → boundary row
  FACE      (YuNet persistence + position stability) → which region is the talking head
  TEMPORAL  (per-row frame-to-frame variance)     → A-roll = low change, B-roll = high

Fusion rule: A-roll side = where the persistent, stable, large face sits; sideAgree is an
INDEPENDENT cross-check (face must sit on the fixed top/bottom-third that is temporally quieter,
not the divider-derived side). A splitScore (seam prominence + differential motion) then decides
the layout TYPE (split vs fullscreen vs broll_only). Then it segments the B-roll region into
shots. Outputs a structured JSON blueprint with confidence + evidence per field.

SCOPE: this core measures RECTANGULAR top/bottom splits and fullscreen/broll-only. It does NOT
detect circular PIP (no HoughCircles here); circle-PIP references are handled by the separate
cv-correction.ts / pip-locator.ts path and would be measured here as `fullscreen`. `shape` is
always "rectangle" from this module.

Stack: OpenCV (the `opencv-python` wheel — the Python bindings are Apache-2.0; the wheel bundles
FFmpeg/codec binaries with their own licenses) + YuNet ONNX (MIT). No non-commercial model
weights. Usage:
  python layout_analyzer.py <reference_video>
"""
import sys, os, json
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")
CANVAS_W, CANVAS_H = 1080, 1920
N_SAMPLE = 60            # frames sampled for layout analysis
GRID_W, GRID_H = 64, 114 # downscaled grid for temporal variance (≈9:16)


def sample(path, n):
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    dur = total / fps if fps else 0
    if total < 4:
        cap.release(); return None
    idxs = np.linspace(0, total - 1, min(n, total)).astype(int)
    color, gray = [], []
    W = H = None
    for fi in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fi))
        ok, fr = cap.read()
        if not ok:
            continue
        if W is None:
            H, W = fr.shape[:2]
        color.append(fr)
        gray.append(cv2.resize(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), (GRID_W, GRID_H)).astype(np.float32))
    cap.release()
    return {"color": color, "gray": np.array(gray), "W": W, "H": H, "fps": fps, "dur": dur, "total": total}


def face_persistence(frames, W, H):
    """Detect faces per frame; return the most A-roll-like band: present, stable, large."""
    det = cv2.FaceDetectorYN.create(MODEL, "", (W, H), score_threshold=0.6)
    det.setInputSize((W, H))
    B = 20
    present = np.zeros(B)            # frames with a face in band b
    area = [[] for _ in range(B)]   # face areas in band b
    cy = [[] for _ in range(B)]     # face center-y (normalized) in band b
    nf = 0
    for fr in frames:
        _, faces = det.detect(fr)
        nf += 1
        seen = set()
        if faces is not None:
            for f in faces:
                cyN = float((f[1] + f[3] / 2) / H)
                b = min(B - 1, max(0, int(cyN * B)))
                seen.add(b)
                area[b].append(float(f[2] * f[3] / (W * H)))
                cy[b].append(cyN)
        for b in seen:
            present[b] += 1
    if nf == 0 or present.max() == 0:
        return None
    # A-roll score per band: coverage × mean-size × position-stability
    best_b, best_score = 0, -1.0
    for b in range(B):
        if present[b] == 0:
            continue
        cov = present[b] / nf
        sz = float(np.mean(area[b])) if area[b] else 0.0
        stab = 1.0 - min(1.0, float(np.std(cy[b])) * 6) if len(cy[b]) > 1 else 1.0
        score = cov * (0.5 + 10 * sz) * stab
        if score > best_score:
            best_score, best_b = score, b
    band = (best_b + 0.5) / B
    return {"cyN": round(band, 3), "coverage": round(present[best_b] / nf, 3),
            "side": "top" if band < 0.5 else "bottom", "score": round(best_score, 3)}


def temporal_profile(gray):
    """Per-row mean frame-to-frame change (B-roll changes a lot; A-roll little)."""
    diffs = np.abs(np.diff(gray, axis=0)).mean(axis=(0, 2))  # (GRID_H,)
    k = 5
    return np.convolve(diffs, np.ones(k) / k, mode="same")


def edge_profile(gray):
    """Per-row PERSISTENT horizontal-edge strength (averaged over frames). The layout seam
    sits at a fixed row → it accumulates; captions move → they average out. So the peak is
    the divider, not the text."""
    gy = np.abs(np.diff(gray, axis=1)).mean(axis=(0, 2))  # (GRID_H-1,)
    gy = np.concatenate([gy, gy[-1:]])
    return np.convolve(gy, np.ones(3) / 3, mode="same")


def find_divider(temporal, edge, face_side, face_cyN):
    """Divider = the persistent horizontal SEAM (+ B-roll→A-roll change step), CONSTRAINED
    so the A-roll region contains the face (divider above the face if A-roll is bottom)."""
    H = len(temporal)
    degenerate = False
    if face_side == "bottom":
        lo, hi = int(0.22 * H), int((face_cyN - 0.03) * H)
    else:
        lo, hi = int((face_cyN + 0.03) * H), int(0.78 * H)
    lo = max(int(0.15 * H), lo); hi = min(int(0.85 * H), hi)
    # If the face-constrained window collapses (e.g. the face sits near the frame edge on the
    # side it supposedly bounds — usually a wrong face pick), don't pin the divider at a garbage
    # value: fall back to the full plausible divider band and flag it degenerate (low trust).
    if hi - lo < int(0.10 * H):
        lo, hi = int(0.25 * H), int(0.75 * H)
        degenerate = True
    e = edge[lo:hi]
    en = (e - e.min()) / (np.ptp(e) + 1e-6)
    w = max(2, H // 20)
    best_y, best_score = (lo + hi) // 2, -1.0
    for i, y in enumerate(range(lo, hi)):
        a0, b1 = max(0, y - w), min(H, y + w)
        step = (temporal[a0:y].mean() - temporal[y:b1].mean()) if face_side == "bottom" else (temporal[y:b1].mean() - temporal[a0:y].mean())
        score = en[i] + 0.6 * max(0.0, step) / (temporal.mean() + 1e-6)  # seam (primary) + change-step
        if score > best_score:
            best_score, best_y = score, y
    frac = best_y / H
    temporal_side = "bottom" if temporal[best_y:].mean() < temporal[:best_y].mean() else "top"
    contrast = float(abs(temporal[:best_y].mean() - temporal[best_y:].mean()) / (temporal.mean() + 1e-6))
    # Seam prominence: how much the divider row's PERSISTENT horizontal edge stands out vs the
    # rest of the frame. A real composited split has a sharp seam here; a single fullscreen shot
    # does not. (Distinguishes split from fullscreen/B-roll-only.)
    seam_prom = float(edge[best_y] / (np.median(edge) + 1e-6))
    return {"frac": round(frac, 3), "temporalSide": temporal_side, "contrast": round(contrast, 3),
            "seamProminence": round(seam_prom, 3), "degenerateWindow": degenerate}


def geometry_divider(frame):
    """HoughLinesP: strongest near-horizontal, near-full-width line → divider fraction."""
    h, w = frame.shape[:2]
    g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(g, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=int(w * 0.4),
                            minLineLength=int(w * 0.6), maxLineGap=20)
    if lines is None:
        return None
    best_y, best_len = None, 0
    for l in lines:
        x1, y1, x2, y2 = l[0]
        if abs(y2 - y1) <= 3 and abs(x2 - x1) >= w * 0.6:  # near-horizontal, wide
            ln = abs(x2 - x1)
            if ln > best_len:
                best_len, best_y = ln, (y1 + y2) / 2
    return round(best_y / h, 3) if best_y is not None else None


def shot_segments(path, region_frac, total, fps, min_shot=0.6):
    """Shot detection INSIDE the B-roll region band. PRIMARY: PySceneDetect ContentDetector
    (industry-standard, BSD-3) — calibrated 2026-07-01 against AdaptiveDetector + FFmpeg
    scene-cut, all three agree ~26 shots on the reference where the old frame-diff heuristic
    under-counted at 11. Falls back to the adaptive frame-diff heuristic if PySceneDetect
    is unavailable."""
    dur = total / (fps or 30)
    segs = _scenedetect_band(path, region_frac, dur)
    if segs is not None:
        return segs
    return _framediff_band(path, region_frac, total, fps, min_shot)


def _scenedetect_band(path, region_frac, dur):
    """PySceneDetect ContentDetector on the B-roll band (cropped to a temp clip). None if
    PySceneDetect / ffmpeg unavailable → caller falls back to the frame-diff heuristic."""
    try:
        from scenedetect import detect, ContentDetector
    except Exception:
        return None
    import tempfile, subprocess
    ffmpeg = os.path.join(HERE, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
    if not os.path.exists(ffmpeg):
        return None
    cap = cv2.VideoCapture(path)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    top, bot = region_frac
    y0 = int(round(top * h)); ch = max(2, int(round(bot * h)) - y0)
    tmp = os.path.join(tempfile.gettempdir(), f"la_shots_{os.getpid()}.mp4")
    try:
        # downscale the band (ContentDetector is scale-robust) → far faster crop + detect on
        # high-res outputs, and a lighter temp file.
        scale = ",scale=384:-2" if w > 384 else ""
        r = subprocess.run([ffmpeg, "-y", "-i", path, "-vf", f"crop={w}:{ch}:0:{y0}{scale}", "-an", "-preset", "ultrafast", tmp],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(tmp):
            return None
        scenes = detect(tmp, ContentDetector(threshold=27))
    except Exception:
        return None
    finally:
        try: os.remove(tmp)
        except OSError: pass
    if not scenes:
        return [{"start": 0.0, "end": round(dur, 2)}]
    segs = [{"start": round(s[0].get_seconds(), 2), "end": round(s[1].get_seconds(), 2)} for s in scenes]
    segs[-1]["end"] = round(dur, 2)
    return segs


def _framediff_band(path, region_frac, total, fps, min_shot=0.6):
    """Fallback: adaptive frame-diff (mean + 1.8·std) in the B-roll band. Under-counts fast
    cuts (kept only for environments without PySceneDetect)."""
    cap = cv2.VideoCapture(path)
    top, bot = region_frac
    step = max(1, int(round((fps or 30) / 6)))
    prev, diffs, times = None, [], []
    fi = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, fr = cap.read()
        if not ok:
            break
        h = fr.shape[0]
        band = fr[int(top * h):int(bot * h)]
        g = cv2.resize(cv2.cvtColor(band, cv2.COLOR_BGR2GRAY), (64, 48)).astype(np.float32)
        if prev is not None:
            diffs.append(float(np.abs(g - prev).mean())); times.append(fi / (fps or 30))
        prev = g
        fi += step
    cap.release()
    dur = total / (fps or 30)
    if not diffs:
        return [{"start": 0.0, "end": round(dur, 2)}]
    d = np.array(diffs)
    thresh = max(16.0, float(d.mean() + 1.8 * d.std()))
    cuts = [0.0] + [round(times[i], 2) for i in range(len(diffs)) if diffs[i] > thresh] + [round(dur, 2)]
    merged = [cuts[0]]
    for c in cuts[1:]:
        if c - merged[-1] >= min_shot:
            merged.append(c)
    if merged[-1] < dur - 0.05:
        merged.append(round(dur, 2))
    return [{"start": merged[i], "end": merged[i + 1]} for i in range(len(merged) - 1)]


def _band_gray(frame, band, size):
    h = frame.shape[0]
    crop = frame[int(band[0] * h):int(band[1] * h)]
    return cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), size)


def analyze_transitions(path, segments, fps, band):
    """Classify each internal shot boundary: hard CUT (one-frame jump) vs CROSSFADE/dissolve
    (change spread over several frames) — measured from the frame-diff concentration."""
    cap = cv2.VideoCapture(path)
    out = []
    for i in range(1, len(segments)):
        t = segments[i]["start"]
        frs = []
        for o in (-0.2, -0.1, 0.0, 0.1, 0.2):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t + o) * 1000)
            ok, f = cap.read()
            if ok:
                frs.append(_band_gray(f, band, (64, 48)).astype(np.float32))
        if len(frs) < 3:
            out.append({"at": round(t, 2), "type": "cut", "duration": 0.0}); continue
        ds = [float(np.abs(frs[j + 1] - frs[j]).mean()) for j in range(len(frs) - 1)]
        conc = max(ds) / (sum(ds) + 1e-6)  # 1.0 = single jump (cut); lower = spread (crossfade)
        if conc > 0.55:
            out.append({"at": round(t, 2), "type": "cut", "duration": 0.0})
        else:
            out.append({"at": round(t, 2), "type": "crossfade", "duration": 0.2})
    cap.release()
    summary = {}
    for x in out:
        summary[x["type"]] = summary.get(x["type"], 0) + 1
    return {"perBoundary": out, "summary": summary, "dominant": (max(summary, key=summary.get) if summary else "cut")}


def analyze_motion(path, segments, fps, band):
    """Per shot, classify camera motion via Farneback optical flow in the B-roll band:
    static / push_in / pull_out / pan / handheld / slow_move."""
    cap = cv2.VideoCapture(path)
    out = []
    for s in segments:
        mid = (s["start"] + s["end"]) / 2.0
        frs = []
        for o in (-0.15, 0.0, 0.15):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, mid + o) * 1000)
            ok, f = cap.read()
            if ok:
                frs.append(_band_gray(f, band, (96, 72)))
        if len(frs) < 2:
            out.append({"start": round(s["start"], 2), "camera": "static", "magnitude": 0.0}); continue
        flow = cv2.calcOpticalFlowFarneback(frs[0], frs[-1], None, 0.5, 3, 15, 3, 5, 1.2, 0)
        fx, fy = flow[..., 0], flow[..., 1]
        mag = float(np.sqrt(fx ** 2 + fy ** 2).mean())
        mx, my = float(fx.mean()), float(fy.mean())
        h2, w2 = fx.shape
        yy, xx = np.mgrid[0:h2, 0:w2]
        # per-pixel RADIAL flow component (normalized by distance → same units as mag):
        # outward (>0) = the frame expands from center = push-in; inward (<0) = pull-out.
        dist = np.sqrt((xx - w2 / 2.0) ** 2 + (yy - h2 / 2.0) ** 2) + 1e-6
        rad = float((((xx - w2 / 2.0) * fx + (yy - h2 / 2.0) * fy) / dist).mean())
        trans = abs(mx) + abs(my)  # net translation (pan/tilt)
        if mag < 0.4:
            cam = "static"
        elif rad > 0.35 * mag and rad > 0.25:
            cam = "push_in"
        elif rad < -0.35 * mag and rad < -0.25:
            cam = "pull_out"
        elif trans > 0.4 * mag and trans > 0.3:
            cam = "pan" if abs(mx) >= abs(my) else "tilt"
        elif mag > 1.2:
            cam = "handheld"
        else:
            cam = "slow_move"
        out.append({"start": round(s["start"], 2), "camera": cam, "magnitude": round(mag, 2),
                    "radial": round(rad, 2), "pan": round(mx, 2), "tilt": round(my, 2)})
    cap.release()
    summary = {}
    for x in out:
        summary[x["camera"]] = summary.get(x["camera"], 0) + 1
    return {"perShot": out, "summary": summary, "dominant": (max(summary, key=summary.get) if summary else "static")}


def analyze_captions(path):
    """Detect a burned-in CAPTION band: rows with high, PERSISTENT text-edge density (text
    is edge-dense and sits at a stable row across frames). Style/text → Gemini (semantics)."""
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if total < 4:
        cap.release(); return {"present": False}
    idxs = np.linspace(0, total - 1, 40).astype(int)
    H = 100
    rows = np.zeros(H)
    nf = 0
    for fi in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fi))
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (180, H))
        rows += cv2.Canny(g, 80, 200).mean(axis=1)
        nf += 1
    cap.release()
    if nf == 0:
        return {"present": False}
    prof = rows / nf
    prof[:int(0.30 * H)] = 0  # captions are rarely in the top 30%
    base = float(np.median(prof[prof > 0])) if (prof > 0).any() else 1.0
    # a text band spans MULTIPLE rows → find the densest contiguous window (not a single edge line)
    win = max(3, int(0.05 * H))
    wsum = np.convolve(prof, np.ones(win), mode="valid")
    wi = int(np.argmax(wsum))
    lo, hi = wi, wi + win
    band_mean = float(prof[lo:hi].mean())
    if band_mean < base * 1.6 or band_mean < 6:
        return {"present": False, "note": "CV fallback; Gemini is authoritative for captions"}
    return {"present": True, "cyN": round((lo + hi) / 2 / H, 3),
            "bandFrac": [round(lo / H, 3), round(hi / H, 3)],
            "region": {"x": 0, "y": int(round(lo / H * CANVAS_H)), "width": CANVAS_W,
                       "height": int(round(win / H * CANVAS_H))},
            "strength": round(band_mean / (base + 1e-6), 2),
            "note": "CV band estimate; Gemini refines text+style"}


def analyze_overlays(path, broll_band):
    """Best-effort PIP-on-PIP / inset detection: rectangular sub-regions inside the B-roll
    band (4-corner contours, bordered, < region). Returns [] if none (the common case)."""
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if total < 4:
        cap.release(); return []
    top, bot = broll_band
    idxs = np.linspace(0, total - 1, 24).astype(int)
    hits = {}
    for fi in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fi))
        ok, f = cap.read()
        if not ok:
            continue
        h, w = f.shape[:2]
        crop = f[int(top * h):int(bot * h)]
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(g, 60, 160)
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        ch, cw = crop.shape[:2]
        for c in cnts:
            ap = cv2.approxPolyDP(c, 0.04 * cv2.arcLength(c, True), True)
            if len(ap) == 4 and cv2.isContourConvex(ap):
                x, y, ww, hh = cv2.boundingRect(ap)
                area = ww * hh / (cw * ch)
                if 0.04 < area < 0.55:  # a real inset, not the whole region or noise
                    key = (round(x / cw, 1), round(y / ch, 1), round(ww / cw, 1))
                    hits[key] = hits.get(key, 0) + 1
    cap.release()
    # keep insets that recur in several frames (stable inset, not edge noise)
    return [{"approxRegion": list(k), "frames": v} for k, v in hits.items() if v >= 4]


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: layout_analyzer.py <video>"})); return
    path = sys.argv[1]
    s = sample(path, N_SAMPLE)
    if s is None:
        print(json.dumps({"error": "cannot read video"})); return

    face = face_persistence(s["color"], s["W"], s["H"])
    profile = temporal_profile(s["gray"])
    edge = edge_profile(s["gray"])
    geo_frac = geometry_divider(s["color"][len(s["color"]) // 2])

    if face is None:
        # no face → temporal-only: A-roll = lower-change side; seam still anchors the boundary
        side_guess = "bottom" if profile[len(profile) // 2:].mean() < profile[:len(profile) // 2].mean() else "top"
        div = find_divider(profile, edge, side_guess, 0.5)
        face_side = div["temporalSide"]
    else:
        face_side = face["side"]
        div = find_divider(profile, edge, face_side, face["cyN"])

    # ── Fusion + self-verify: do face, temporal, geometry agree? ──
    temporal_side = div["temporalSide"]
    frac = div["frac"]
    if geo_frac is not None and abs(geo_frac - frac) < 0.08:
        frac = round((frac + geo_frac) / 2, 3)  # refine boundary with geometry
        geo_agree = True
    else:
        geo_agree = False
    # INDEPENDENT side cross-check: the divider-based temporalSide is partly self-fulfilling
    # (the divider is searched on the face's side), so it can't catch an inverted face pick.
    # Compare the FIXED top-third vs bottom-third temporal variance — the A-roll (talking head)
    # side is the quieter third, independent of where the divider landed. sideAgree requires the
    # face to sit on the independently-quieter side, so a wrong face band is caught (agree=False).
    third = max(1, len(profile) // 3)
    top_var = float(profile[:third].mean())
    bot_var = float(profile[-third:].mean())
    independent_side = "bottom" if bot_var < top_var else "top"
    side_agree = (face is not None and face_side == independent_side)
    side_agree_divider = (face is not None and face_side == temporal_side)

    # ── Layout-TYPE classification: is this REALLY a top/bottom split, or a single
    # fullscreen shot / B-roll-only montage? A real composited split has (a) a prominent
    # persistent horizontal SEAM at the divider, and (b) differential motion across it (a
    # static A-roll side + a busy B-roll side) with the face on the static side. A single
    # fullscreen clip has neither. Measured separation on real footage: true split
    # seamProminence≈2.5 vs non-split 1.2–1.6; split contrast≈0.38 (band) vs 0.02 / 0.91. ──
    seam_prom = float(div.get("seamProminence") or 0.0)
    contrast = float(div["contrast"])
    split_score = min(1.0, max(0.0, (seam_prom - 1.3) / 1.0)) * 0.6
    if 0.12 <= contrast <= 0.7:
        split_score += 0.4 if side_agree else 0.2
    split_score = round(split_score, 3)
    is_split = split_score >= 0.5
    type_uncertain = 0.4 <= split_score < 0.6
    degenerate = bool(div.get("degenerateWindow"))
    if is_split:
        layout_type = "split"
        # confidence: face+INDEPENDENT-side agreement is primary; geometry refines
        conf = 0.5
        if face is not None:
            conf = 0.6 + 0.2 * (face["coverage"]) + (0.15 if side_agree else -0.15)
        conf += 0.1 if geo_agree else 0.0
        if degenerate:
            conf -= 0.25  # the face-constrained divider window collapsed → divider untrustworthy
        conf = round(float(np.clip(conf, 0.05, 0.99)), 2)
    else:
        # not a split: fullscreen talking head if a stable face dominates, else B-roll-only
        layout_type = "fullscreen" if (face is not None and face["coverage"] >= 0.3) else "broll_only"
        conf = round(float(np.clip(0.5 + 0.4 * (1.0 - split_score), 0.3, 0.95)), 2)

    aroll_side = face_side
    if is_split:
        # canvas-space regions (A-roll on its side of the divider, B-roll on the other)
        div_y = int(round(frac * CANVAS_H))
        if aroll_side == "bottom":
            aroll = {"x": 0, "y": div_y, "width": CANVAS_W, "height": CANVAS_H - div_y}
            broll = {"x": 0, "y": 0, "width": CANVAS_W, "height": div_y}
            broll_band = (0.0, frac)
        else:
            aroll = {"x": 0, "y": 0, "width": CANVAS_W, "height": div_y}
            broll = {"x": 0, "y": div_y, "width": CANVAS_W, "height": CANVAS_H - div_y}
            broll_band = (frac, 1.0)
    else:
        # fullscreen / broll-only: the whole 9:16 frame; no real divider
        aroll = {"x": 0, "y": 0, "width": CANVAS_W, "height": CANVAS_H}
        broll = {"x": 0, "y": 0, "width": CANVAS_W, "height": CANVAS_H}
        broll_band = (0.0, 1.0)
    aspect = lambda r: round(r["width"] / max(1, r["height"]), 3)

    segs = shot_segments(path, broll_band, s["total"], s["fps"])
    durs = [x["end"] - x["start"] for x in segs]

    transitions = analyze_transitions(path, segs, s["fps"], broll_band)
    motion = analyze_motion(path, segs, s["fps"], broll_band)
    captions = analyze_captions(path)
    overlays = analyze_overlays(path, broll_band)

    # Persistent horizontal-edge strength per grid row, normalized 0..1 — exported so the
    # Node unifier can SNAP the VLM's coarse band boundaries to measured seams.
    edge_norm = (edge - edge.min()) / (float(np.ptp(edge)) + 1e-6)

    print(json.dumps({
        "duration": round(s["dur"], 2),
        "fps": round(s["fps"], 2),
        "dims": [s["W"], s["H"]],
        "edgeProfile": [round(float(v), 4) for v in edge_norm],
        "layout": {
            "type": layout_type,
            "arollSide": aroll_side,
            "arollRegion": aroll,
            "brollRegion": broll,
            "brollAspect": aspect(broll),
            "arollAspect": aspect(aroll),
            "dividerFraction": frac if is_split else None,
            "shape": "rectangle",
            "confidence": conf,
            "splitScore": split_score,
            "typeUncertain": type_uncertain,
            "evidence": {
                "face": face,
                "temporalSide": temporal_side,
                "independentSide": independent_side,
                "temporalContrast": div["contrast"],
                "seamProminence": div.get("seamProminence"),
                "geometryDivider": geo_frac,
                "sideAgree": side_agree,
                "sideAgreeDivider": side_agree_divider,
                "geometryAgree": geo_agree,
            },
        },
        "segments": segs,
        "rhythm": {
            "shots": len(segs),
            "avgShotSec": round(float(np.mean(durs)), 2) if durs else 0,
            "cutFrequency": "fast" if (durs and np.mean(durs) < 1.8) else "moderate" if (durs and np.mean(durs) < 3.5) else "slow",
        },
        "transitions": transitions,
        "motion": motion,
        "captions": captions,
        "overlays": overlays,
    }))


if __name__ == "__main__":
    main()
