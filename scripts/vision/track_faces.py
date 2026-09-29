#!/usr/bin/env python3
"""
Real face-detection sampler for PeakCut's local subject-tracking engine.

Uses OpenCV's built-in Haar frontal-face cascade (shipped with the
opencv-python-headless package itself — no separate model download, no
network access). This is a real, if modest, detector: a classic Haar
cascade, not a deep-learning face detector, and it reports only rough,
uncalibrated confidence derived from the cascade's own reject-level
weights — never a fabricated precise probability.

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
import sys


def emit_error(message: str) -> None:
    print(json.dumps({"error": message}))


def main() -> int:
    if len(sys.argv) < 2:
        emit_error("usage: track_faces.py <media_path> [sample_fps]")
        return 1

    media_path = sys.argv[1]
    try:
        sample_fps = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
    except ValueError:
        emit_error("sample_fps doit être un nombre.")
        return 1
    if sample_fps <= 0:
        emit_error("sample_fps doit être strictement positif.")
        return 1

    try:
        import cv2  # noqa: WPS433 (import-in-function keeps a missing dependency a clean, controlled error)
    except ImportError as exc:
        emit_error(f"OpenCV (cv2) n'est pas installé : {exc}")
        return 1

    cap = cv2.VideoCapture(media_path)
    if not cap.isOpened():
        emit_error(f"Impossible d'ouvrir le fichier média : {media_path}")
        return 1

    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        if width <= 0 or height <= 0 or video_fps <= 0 or frame_count <= 0:
            emit_error("Métadonnées vidéo invalides ou illisibles (dimensions/fps/nombre d'images).")
            return 1

        duration_sec = frame_count / video_fps

        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)
        if face_cascade.empty():
            emit_error("Le classifieur Haar frontal d'OpenCV est introuvable ou n'a pas pu être chargé.")
            return 1

        frame_interval = max(1, round(video_fps / sample_fps))

        detections = []
        frame_index = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_index % frame_interval == 0:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces, _reject_levels, level_weights = face_cascade.detectMultiScale3(
                    gray,
                    scaleFactor=1.1,
                    minNeighbors=5,
                    outputRejectLevels=True,
                )
                t_sec = frame_index / video_fps
                for (fx, fy, fw, fh), weight in zip(faces, level_weights):
                    # level_weight is an uncalibrated cascade decision weight, not a
                    # probability — this is a deliberately rough, documented heuristic.
                    confidence = max(0.05, min(0.99, float(weight) / 10.0))
                    detections.append(
                        {
                            "tSec": round(t_sec, 3),
                            "x": round(fx / width, 6),
                            "y": round(fy / height, 6),
                            "width": round(fw / width, 6),
                            "height": round(fh / height, 6),
                            "confidence": round(confidence, 4),
                            "kind": "face",
                        }
                    )
            frame_index += 1

        result = {
            "source": {"width": width, "height": height, "duration_sec": round(duration_sec, 3)},
            "detections": detections,
        }
        print(json.dumps(result))
        return 0
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure must become controlled JSON.
        emit_error(f"Échec de la détection : {exc}")
        return 1
    finally:
        cap.release()


if __name__ == "__main__":
    sys.exit(main())
