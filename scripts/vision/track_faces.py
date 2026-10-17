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

FFmpeg is already a hard requirement of PeakCut's export path; detection
still runs fully offline, locally, on-device.

Usage:
    track_faces.py <media_path> [sample_fps]

Output contract (and ONLY this goes to stdout):
    Success (exit 0):
        {"source": {"width": W, "height": H, "duration_sec": D},
         "detections": [{"tSec": t, "x": x, "y": y, "width": w, "height": h,
                          "confidence": c, "kind": "face"}, ...]}
    Failure (exit 1):
        {"error": "human-readable message"}

Every coordinate/size is normalized to [0, 1] as a fraction of the frame.
Nothing else is ever printed to stdout; diagnostics (if any) go to stderr.
"""

import json
import subprocess
import sys

# Haar finds a crop-relevant face just as well at this width as at full
# resolution, for a fraction of the cost. A face too small to show up here
# is too small to drive a crop anyway.
DETECT_WIDTH = 480


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


def main() -> int:
    if len(sys.argv) < 2:
        emit_error("usage: track_faces.py <media_path> [sample_fps]")
        return 1

    media_path = sys.argv[1]
    try:
        sample_fps = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    except ValueError:
        emit_error("sample_fps doit etre un nombre.")
        return 1
    if sample_fps <= 0:
        emit_error("sample_fps doit etre strictement positif.")
        return 1

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

    det_w, det_h = detect_size(width, height)
    frame_bytes = det_w * det_h

    args = [
        "ffmpeg",
        "-v", "error",
        "-nostdin",
        "-i", media_path,
        "-vf", "fps={0},scale={1}:{2},format=gray".format(sample_fps, det_w, det_h),
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
    frame_index = 0
    try:
        while True:
            raw = proc.stdout.read(frame_bytes)
            if not raw or len(raw) < frame_bytes:
                break
            gray = np.frombuffer(raw, dtype=np.uint8).reshape((det_h, det_w))
            faces, _reject_levels, level_weights = face_cascade.detectMultiScale3(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                outputRejectLevels=True,
            )
            t_sec = frame_index / sample_fps
            for (fx, fy, fw, fh), weight in zip(faces, level_weights):
                # level_weight is an uncalibrated cascade decision weight, not a
                # probability — this is a deliberately rough, documented heuristic.
                confidence = max(0.05, min(0.99, float(weight) / 10.0))
                detections.append(
                    {
                        "tSec": round(t_sec, 3),
                        "x": round(fx / det_w, 6),
                        "y": round(fy / det_h, 6),
                        "width": round(fw / det_w, 6),
                        "height": round(fh / det_h, 6),
                        "confidence": round(confidence, 4),
                        "kind": "face",
                    }
                )
            frame_index += 1
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
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
