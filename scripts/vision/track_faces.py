#!/usr/bin/env python3
"""
Real face-detection sampler for PeakCut's local subject-tracking engine.

Uses OpenCV's built-in Haar frontal-face cascade (shipped with the
opencv-python-headless package itself — no separate model download, no
network access). This is a real, if modest, detector: a classic Haar
cascade, not a deep-learning face detector, and it reports only rough,
uncalibrated confidence derived from the cascade's own reject-level
weights — never a fabricated precise probability.

Frames are decoded by FFmpeg, not by OpenCV, and the cascade runs on a
downscaled copy. Both choices are about finishing at all rather than about
micro-optimization: on a 10-minute 1080p60 source, decoding every frame
through cv2.VideoCapture and detecting at full resolution measured 17
minutes, against roughly 40 seconds this way. FFmpeg's `fps` filter decodes
once and hands back only the sampled frames, and a Haar cascade costs ~29x
less at 480px wide than at 1920px while still finding the faces that can
drive a crop. Coordinates are normalized against the downscaled frame, so
they remain valid fractions of the original frame.

Two further things are reported per detection, and they are what lets a
short follow the person who is actually talking:

  * `track_id` — the same face across frames, matched by position. The
    detector answers "where are the faces"; this answers "which of them is
    the same person", which is what "frame on the speaker" needs.
  * `activity` — how much that face's mouth region moved, measured between
    frames decoded at a *higher* rate than faces are detected at. Mouth
    movement is invisible at one sample per second, so frames are decoded
    at `activity_fps` and the cascade is run every N-th of them: detection
    costs exactly what it did before, and the frames in between are used
    only to difference each known mouth region. The frame's own global
    motion is subtracted, so a camera move or a cut does not read as
    everyone speaking at once.

`activity` is a measurement, not a verdict: nothing here decides who the
speaker is. That is decided later, shot by shot, by comparing the faces
on screen at the same moment while someone is speaking (see
lib/tracking/buildFaceFraming.ts).

The camera cuts of an edited video are reported as well (`cuts`, in
seconds): the frame has to change exactly there, and a face seen before a
cut is not the face at the same place after it. On a cut, tracks are
ended and faces are detected on the new shot at once. Faces are looked
for from the front first, then in profile, which a close-up shows often.

FFmpeg is already a hard requirement of PeakCut's export path; detection
still runs fully offline, locally, on-device.

Usage:
    track_faces.py <media_path> [detect_fps] [activity_fps]

Output contract (and ONLY this goes to stdout):
    Success (exit 0):
        {"source": {"width": W, "height": H, "duration_sec": D},
         "detections": [{"tSec": t, "x": x, "y": y, "width": w, "height": h,
                          "confidence": c, "kind": "face",
                          "track_id": "t1", "activity": a}, ...],
         "cuts": [t, ...]}
    Failure (exit 1):
        {"error": "human-readable message"}

Every coordinate/size is normalized to [0, 1] as a fraction of the frame;
`activity` is normalized to [0, 1] as a fraction of full-scale luma.
Nothing else is ever printed to stdout; diagnostics (if any) go to stderr.
"""

import json
import subprocess
import sys

# Haar finds a crop-relevant face just as well at this width as at full
# resolution, for a fraction of the cost. A face too small to show up here
# is too small to drive a crop anyway.
DETECT_WIDTH = 480

# How far a face may move between two detections and still count as the
# same person, as a fraction of the frame. Same value, and same reasoning,
# as groupSubjectTracks on the TypeScript side.
MAX_TRACK_DISTANCE = 0.12

# A track unseen for this many detection frames is closed; a later face at
# that spot starts a new track rather than resurrecting a stale one.
MAX_TRACK_MISSES = 4

# The mouth, as a fraction of a Haar frontal-face box: the cascade's box
# runs from forehead to chin, so the mouth sits low and centred. A region
# rather than a landmark because this cascade has no landmarks, and a
# region is enough to tell a moving mouth from a still one.
MOUTH_X0, MOUTH_X1 = 0.25, 0.75
MOUTH_Y0, MOUTH_Y1 = 0.60, 0.95

# A camera cut, as seen between two decoded frames: the whole picture
# changes at once, then holds. Measured on an edited show (median frame
# difference 0.014, cuts 0.15-0.7) and on a streamer's montage, a cut is a
# spike on one frame pair, at least CUT_MIN_DIFFERENCE of full scale and
# CUT_SPIKE_RATIO times both of its neighbours. The ratio is what tells a
# cut from a big gesture or a camera move, which reach the same amplitude
# but spread it over several consecutive frames.
#
# A grey-level histogram is no help here: on a dark set lit the same way
# from every angle, two different shots have near-identical histograms.
CUT_MIN_DIFFERENCE = 0.08
CUT_SPIKE_RATIO = 2.5
# Floor for the neighbours in the ratio: next to a perfectly still frame,
# any flicker would otherwise be "infinitely" larger than its neighbours.
CUT_NEIGHBOUR_FLOOR = 0.01


def emit_error(message: str) -> None:
    print(json.dumps({"error": message}))


def probe_metadata(media_path: str):
    """Reads dimensions/fps/frame count through property reads only — no decoding."""
    import cv2

    cap = cv2.VideoCapture(media_path)
    if not cap.isOpened():
        return None, "Impossible d'ouvrir le fichier media : " + media_path
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    finally:
        cap.release()

    if width <= 0 or height <= 0 or video_fps <= 0 or frame_count <= 0:
        return None, "Metadonnees video invalides ou illisibles (dimensions/fps/nombre d'images)."
    return (width, height, video_fps, frame_count / video_fps), None


def detect_size(width: int, height: int):
    """Downscaled detection frame size. Never upscales a source smaller than DETECT_WIDTH."""
    target_w = min(DETECT_WIDTH, width)
    scaled_h = max(2, round(height * (target_w / width)))
    # Even dimensions keep every FFmpeg scaler and pixel format happy.
    return max(2, target_w - (target_w % 2)), max(2, scaled_h - (scaled_h % 2))


def mouth_region(box, det_w: int, det_h: int):
    """The mouth sub-rectangle of a face box, clamped to the frame."""
    fx, fy, fw, fh = box
    x0 = max(0, min(det_w - 1, int(fx + MOUTH_X0 * fw)))
    x1 = max(x0 + 1, min(det_w, int(fx + MOUTH_X1 * fw)))
    y0 = max(0, min(det_h - 1, int(fy + MOUTH_Y0 * fh)))
    y1 = max(y0 + 1, min(det_h, int(fy + MOUTH_Y1 * fh)))
    return x0, y0, x1, y1


def box_center(box):
    fx, fy, fw, fh = box
    return fx + fw / 2.0, fy + fh / 2.0


def match_detections(tracks, boxes, det_w: int, det_h: int, next_track_number: int):
    """
    Assigns each detected box to a live track, closest pair first.

    Returns (assignments, next_track_number): assignments maps the index of
    a box to the track id it belongs to, creating tracks for boxes that
    match nothing.
    """
    diagonal = (det_w ** 2 + det_h ** 2) ** 0.5
    pairs = []
    for box_index, box in enumerate(boxes):
        bcx, bcy = box_center(box)
        for track_id, track in tracks.items():
            tcx, tcy = box_center(track["box"])
            distance = ((bcx - tcx) ** 2 + (bcy - tcy) ** 2) ** 0.5 / diagonal
            if distance <= MAX_TRACK_DISTANCE:
                pairs.append((distance, box_index, track_id))
    pairs.sort()

    assignments = {}
    taken_tracks = set()
    for _distance, box_index, track_id in pairs:
        if box_index in assignments or track_id in taken_tracks:
            continue
        assignments[box_index] = track_id
        taken_tracks.add(track_id)

    for box_index in range(len(boxes)):
        if box_index in assignments:
            continue
        track_id = "t{0}".format(next_track_number)
        next_track_number += 1
        tracks[track_id] = {"box": boxes[box_index], "misses": 0, "pending": None, "sum": 0.0, "count": 0}
        assignments[box_index] = track_id

    return assignments, next_track_number


def accumulate_activity(difference, tracks, det_w: int, det_h: int) -> None:
    """
    Adds one frame's worth of mouth movement to every live track.

    `difference` is the absolute difference between this frame and the
    previous one, as a 2-D array of bytes. The frame's own global motion is
    subtracted from each mouth region: on a camera move or a cut every
    mouth region "moves", and without that baseline every face would look
    like it was talking at once. The result is clamped at zero, so a face
    that moved less than the whole frame reads as still rather than as
    negatively speaking.
    """
    global_motion = float(difference.mean()) / 255.0
    for track in tracks.values():
        x0, y0, x1, y1 = mouth_region(track["box"], det_w, det_h)
        mouth_motion = float(difference[y0:y1, x0:x1].mean()) / 255.0
        track["sum"] += max(0.0, mouth_motion - global_motion)
        track["count"] += 1


def close_activity_window(tracks) -> None:
    """
    Attaches the motion measured since the last detection to the detection
    it belongs to, and resets the accumulators.

    A detection with no measured frames keeps no `activity` key at all: an
    absent measurement and a measurement of zero mean opposite things to
    whoever matches voices to faces, and writing 0.0 here would turn "we
    did not look" into "this face was perfectly still".
    """
    for track in tracks.values():
        pending = track["pending"]
        if pending is not None and track["count"] > 0:
            pending["activity"] = round(track["sum"] / track["count"], 5)
        track["pending"] = None
        track["sum"] = 0.0
        track["count"] = 0


def is_cut(before: float, spike: float, after: float) -> bool:
    """Whether the frame pair measured `spike` is a camera cut, given the pairs on either side of it."""
    neighbour = max(before, after, CUT_NEIGHBOUR_FLOOR)
    return spike >= CUT_MIN_DIFFERENCE and spike >= CUT_SPIKE_RATIO * neighbour


def detect_faces(cv2, gray, frontal, profile):
    """
    Faces in one frame: frontal first, then — only when no face is seen
    from the front — in profile, looking both ways.

    An interview cut in close-ups shows people side-on a good part of the
    time, and the frontal cascade sees nothing there: the shot would then
    keep whatever framing came before it, typically the other person's.
    The profile cascade only finds faces turned to one side, so the frame
    is mirrored to find the other one, and its boxes are mirrored back.
    """
    faces, _levels, weights = frontal.detectMultiScale3(gray, scaleFactor=1.1, minNeighbors=5, outputRejectLevels=True)
    found = [(tuple(int(v) for v in face), float(weight)) for face, weight in zip(faces, weights)]
    if found or profile is None:
        return found

    width = gray.shape[1]
    for mirrored in (False, True):
        image = cv2.flip(gray, 1) if mirrored else gray
        faces, _levels, weights = profile.detectMultiScale3(image, scaleFactor=1.1, minNeighbors=5, outputRejectLevels=True)
        for face, weight in zip(faces, weights):
            fx, fy, fw, fh = (int(v) for v in face)
            if mirrored:
                fx = width - fx - fw
            found.append(((fx, fy, fw, fh), float(weight)))
    return found


def main() -> int:
    if len(sys.argv) < 2:
        emit_error("usage: track_faces.py <media_path> [detect_fps] [activity_fps]")
        return 1

    media_path = sys.argv[1]
    try:
        detect_fps = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
        activity_fps = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
    except ValueError:
        emit_error("detect_fps et activity_fps doivent etre des nombres.")
        return 1
    if detect_fps <= 0:
        emit_error("detect_fps doit etre strictement positif.")
        return 1
    if activity_fps <= 0:
        emit_error("activity_fps doit etre strictement positif.")
        return 1

    # Detecting more often than we decode is impossible; the decode rate
    # wins and detection simply runs on every decoded frame.
    activity_fps = max(activity_fps, detect_fps)
    stride = max(1, int(round(activity_fps / detect_fps)))

    try:
        import cv2  # noqa: WPS433 (import-in-function keeps a missing dependency a clean, controlled error)
        import numpy as np
    except ImportError as exc:
        emit_error("OpenCV (cv2) n'est pas installe : " + str(exc))
        return 1

    meta, meta_error = probe_metadata(media_path)
    if meta_error:
        emit_error(meta_error)
        return 1
    width, height, _video_fps, duration_sec = meta

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        emit_error("Le classifieur Haar frontal d'OpenCV est introuvable ou n'a pas pu etre charge.")
        return 1
    # Optional: without it, faces seen side-on are simply not found, as before.
    profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    if profile_cascade.empty():
        profile_cascade = None

    det_w, det_h = detect_size(width, height)
    frame_bytes = det_w * det_h

    args = [
        "ffmpeg",
        "-v", "error",
        "-nostdin",
        "-i", media_path,
        "-vf", "fps={0},scale={1}:{2},format=gray".format(activity_fps, det_w, det_h),
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "-",
    ]
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        emit_error(
            "ffmpeg est introuvable : la detection de sujet decode les images via FFmpeg. "
            "Installez FFmpeg et assurez-vous qu'il est sur le PATH."
        )
        return 1
    except OSError as exc:
        emit_error("ffmpeg n'a pas pu etre lance : " + str(exc))
        return 1

    detections = []
    cuts = []
    tracks = {}
    next_track_number = 1
    previous_gray = None
    # Frame differences of the last two pairs: a pair is judged a cut only
    # once the pair after it is known (see is_cut).
    recent_levels = []
    frame_index = 0
    try:
        while True:
            raw = proc.stdout.read(frame_bytes)
            if not raw or len(raw) < frame_bytes:
                break
            gray = np.frombuffer(raw, dtype=np.uint8).reshape((det_h, det_w))

            cut_now = False
            difference = None
            if previous_gray is not None:
                difference = cv2.absdiff(gray, previous_gray)
                level = float(difference.mean()) / 255.0
                if len(recent_levels) == 2 and is_cut(recent_levels[0], recent_levels[1], level):
                    cut_now = True
                    cuts.append(round((frame_index - 1) / activity_fps, 3))
                recent_levels = (recent_levels + [level])[-2:]

            if cut_now:
                # Every face of the previous shot is gone: its tracks end
                # here, and the new shot is looked at right away rather
                # than up to a detection interval later.
                close_activity_window(tracks)
                tracks.clear()
            elif difference is not None and tracks:
                accumulate_activity(difference, tracks, det_w, det_h)

            if frame_index % stride == 0 or cut_now:
                close_activity_window(tracks)

                found = detect_faces(cv2, gray, face_cascade, profile_cascade)
                boxes = [box for box, _weight in found]
                level_weights = [weight for _box, weight in found]
                assignments, next_track_number = match_detections(
                    tracks, boxes, det_w, det_h, next_track_number
                )

                t_sec = frame_index / activity_fps
                seen_tracks = set()
                for box_index, (box, weight) in enumerate(zip(boxes, level_weights)):
                    track_id = assignments[box_index]
                    fx, fy, fw, fh = box
                    # level_weight is an uncalibrated cascade decision weight, not a
                    # probability — this is a deliberately rough, documented heuristic.
                    confidence = max(0.05, min(0.99, float(weight) / 10.0))
                    detection = {
                        "tSec": round(t_sec, 3),
                        "x": round(fx / det_w, 6),
                        "y": round(fy / det_h, 6),
                        "width": round(fw / det_w, 6),
                        "height": round(fh / det_h, 6),
                        "confidence": round(confidence, 4),
                        "kind": "face",
                        "track_id": track_id,
                    }
                    detections.append(detection)
                    tracks[track_id]["box"] = box
                    tracks[track_id]["misses"] = 0
                    tracks[track_id]["pending"] = detection
                    seen_tracks.add(track_id)

                for track_id in list(tracks.keys()):
                    if track_id in seen_tracks:
                        continue
                    tracks[track_id]["misses"] += 1
                    if tracks[track_id]["misses"] > MAX_TRACK_MISSES:
                        del tracks[track_id]

            previous_gray = gray
            frame_index += 1

        close_activity_window(tracks)
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure must become controlled JSON.
        proc.kill()
        proc.wait()
        emit_error("Echec de la detection : " + str(exc))
        return 1
    finally:
        if proc.stdout:
            proc.stdout.close()

    stderr_text = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    exit_code = proc.wait()

    # A decoder that died mid-file would otherwise pass for a short video
    # with honestly-reported detections. Fail rather than under-report.
    if exit_code != 0:
        emit_error("ffmpeg a echoue (code {0}) : {1}".format(exit_code, stderr_text.strip()[-800:]))
        return 1
    if frame_index == 0:
        emit_error("Aucune image n'a pu etre decodee depuis ce media.")
        return 1

    result = {
        "source": {"width": width, "height": height, "duration_sec": round(duration_sec, 3)},
        "detections": detections,
        "cuts": cuts,
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
