#!/usr/bin/env python3
"""
Unit tests for the parts of track_faces.py that decide *who* is in frame
and *whose mouth moved* — the two things active-speaker framing rests on.

The TypeScript side is covered by Vitest, but this logic lives in Python
and nothing else exercises it: a detection script that silently stopped
matching faces across frames would simply report every face as a new
person, and the framing would quietly go back to never following the
speaker. Run it with the vision venv, which already has numpy:

    .venv-vision/bin/python -m unittest discover -s scripts/vision -p "*_test.py"
    # Windows : .venv-vision\\Scripts\\python.exe -m unittest discover -s scripts/vision -p "*_test.py"

No video and no OpenCV are needed: track_faces.py imports cv2 inside the
functions that use it, so importing the module costs nothing.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from track_faces import (  # noqa: E402  (path set above on purpose)
    accumulate_activity,
    close_activity_window,
    detect_size,
    match_detections,
    mouth_region,
)


def new_track(box):
    return {"box": box, "misses": 0, "pending": None, "sum": 0.0, "count": 0}


class MouthRegionTest(unittest.TestCase):
    def test_sits_low_and_centred_in_the_face_box(self):
        x0, y0, x1, y1 = mouth_region((100, 100, 80, 100), 480, 270)
        self.assertEqual((x0, x1), (120, 160))
        self.assertEqual((y0, y1), (160, 195))

    def test_stays_inside_the_frame_for_a_box_on_the_edge(self):
        x0, y0, x1, y1 = mouth_region((460, 250, 80, 100), 480, 270)
        self.assertLessEqual(x1, 480)
        self.assertLessEqual(y1, 270)
        self.assertLess(x0, x1)
        self.assertLess(y0, y1)

    def test_never_produces_an_empty_region(self):
        for box in [(0, 0, 1, 1), (479, 269, 1, 1), (0, 0, 0, 0)]:
            x0, y0, x1, y1 = mouth_region(box, 480, 270)
            self.assertLess(x0, x1, box)
            self.assertLess(y0, y1, box)


class MatchDetectionsTest(unittest.TestCase):
    def test_keeps_the_same_identity_for_a_face_that_barely_moved(self):
        tracks = {"t1": new_track((100, 100, 60, 60))}
        assignments, next_number = match_detections(tracks, [(104, 102, 60, 60)], 480, 270, 2)
        self.assertEqual(assignments, {0: "t1"})
        self.assertEqual(next_number, 2)

    def test_opens_a_new_identity_rather_than_teleporting_one(self):
        tracks = {"t1": new_track((10, 100, 60, 60))}
        assignments, next_number = match_detections(tracks, [(400, 100, 60, 60)], 480, 270, 2)
        self.assertEqual(assignments, {0: "t2"})
        self.assertEqual(next_number, 3)
        self.assertIn("t2", tracks)

    def test_two_faces_side_by_side_keep_their_own_identities(self):
        tracks = {"t1": new_track((60, 100, 60, 60)), "t2": new_track((300, 100, 60, 60))}
        # Fed in the order that a naive first-come pass would get wrong.
        assignments, _ = match_detections(tracks, [(302, 100, 60, 60), (58, 100, 60, 60)], 480, 270, 3)
        self.assertEqual(assignments, {0: "t2", 1: "t1"})

    def test_one_detection_cannot_take_an_identity_already_claimed(self):
        tracks = {"t1": new_track((100, 100, 60, 60))}
        assignments, _ = match_detections(tracks, [(101, 100, 60, 60), (103, 100, 60, 60)], 480, 270, 2)
        self.assertEqual(assignments[0], "t1")
        self.assertNotEqual(assignments[1], "t1")


class AccumulateActivityTest(unittest.TestCase):
    def build(self):
        # Two faces, far apart; only the left one's mouth region changes.
        return {"left": new_track((40, 40, 60, 80)), "right": new_track((300, 40, 60, 80))}

    def test_a_moving_mouth_scores_above_a_still_one(self):
        tracks = self.build()
        difference = np.zeros((270, 480), dtype=np.uint8)
        x0, y0, x1, y1 = mouth_region(tracks["left"]["box"], 480, 270)
        difference[y0:y1, x0:x1] = 90

        accumulate_activity(difference, tracks, 480, 270)

        self.assertGreater(tracks["left"]["sum"], tracks["right"]["sum"])
        self.assertEqual(tracks["right"]["sum"], 0.0)
        self.assertEqual(tracks["left"]["count"], 1)

    def test_whole_frame_motion_does_not_make_everyone_speak(self):
        tracks = self.build()
        # A camera move or a cut: everything changed by the same amount.
        difference = np.full((270, 480), 70, dtype=np.uint8)

        accumulate_activity(difference, tracks, 480, 270)

        self.assertEqual(tracks["left"]["sum"], 0.0)
        self.assertEqual(tracks["right"]["sum"], 0.0)

    def test_scores_stay_inside_zero_and_one(self):
        tracks = self.build()
        difference = np.zeros((270, 480), dtype=np.uint8)
        x0, y0, x1, y1 = mouth_region(tracks["left"]["box"], 480, 270)
        difference[y0:y1, x0:x1] = 255

        accumulate_activity(difference, tracks, 480, 270)

        self.assertGreaterEqual(tracks["left"]["sum"], 0.0)
        self.assertLessEqual(tracks["left"]["sum"], 1.0)


class CloseActivityWindowTest(unittest.TestCase):
    def test_attaches_the_measured_mean_to_the_pending_detection(self):
        detection = {"tSec": 1.0}
        tracks = {"t1": new_track((10, 10, 40, 40))}
        tracks["t1"].update({"pending": detection, "sum": 0.12, "count": 4})

        close_activity_window(tracks)

        self.assertAlmostEqual(detection["activity"], 0.03)
        self.assertIsNone(tracks["t1"]["pending"])
        self.assertEqual(tracks["t1"]["count"], 0)

    def test_leaves_activity_absent_when_nothing_was_measured(self):
        # "Not measured" and "measured as still" lead to opposite
        # conclusions about who is speaking; writing 0.0 here would turn
        # the first into the second.
        detection = {"tSec": 1.0}
        tracks = {"t1": new_track((10, 10, 40, 40))}
        tracks["t1"]["pending"] = detection

        close_activity_window(tracks)

        self.assertNotIn("activity", detection)


class DetectSizeTest(unittest.TestCase):
    def test_downscales_to_the_detection_width_with_even_dimensions(self):
        self.assertEqual(detect_size(1920, 1080), (480, 270))

    def test_never_upscales_a_small_source(self):
        width, height = detect_size(320, 180)
        self.assertEqual(width, 320)
        self.assertEqual(height, 180)


if __name__ == "__main__":
    unittest.main()
