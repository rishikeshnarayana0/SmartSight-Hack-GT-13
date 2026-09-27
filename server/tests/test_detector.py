import base64
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from detector import Detection, build_canny_edge_map, stair_direction_for_label


class DetectorOverlayTests(unittest.TestCase):
    def test_directional_stair_labels_are_normalized(self) -> None:
        self.assertEqual(stair_direction_for_label("stairs_up"), "up")
        self.assertEqual(stair_direction_for_label("Downstairs"), "down")
        self.assertIsNone(stair_direction_for_label("stairs"))

    def test_detection_serializes_normalized_box(self) -> None:
        detection = Detection("chair", 0.87654, 0.1, 0.2, 0.3, 0.4)
        self.assertEqual(
            detection.as_dict(),
            {
                "label": "chair",
                "confidence": 0.877,
                "x": 0.1,
                "y": 0.2,
                "width": 0.3,
                "height": 0.4,
            },
        )

    def test_canny_overlay_is_a_small_png(self) -> None:
        image = Image.new("RGB", (320, 240), "black")
        ImageDraw.Draw(image).rectangle((40, 40, 280, 200), outline="white", width=4)
        encoded = build_canny_edge_map(image)
        self.assertIsNotNone(encoded)
        self.assertLess(len(encoded or ""), 20_000)
        raw = base64.b64decode(encoded or "")
        self.assertTrue(raw.startswith(b"\x89PNG"))
        decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        self.assertIsNotNone(decoded)
        self.assertEqual(int(decoded[:, :, 3].max()), 190)
        self.assertEqual(int(decoded[:10, :, 3].max()), 0)


if __name__ == "__main__":
    unittest.main()
