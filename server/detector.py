"""Fast object-detection gate for the slower vision-language model."""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
from dataclasses import dataclass
from typing import Any

from PIL import Image


class DetectorError(RuntimeError):
    """Raised when the object detector is unavailable or cannot process a frame."""


@dataclass(frozen=True)
class Detection:
    """A normalized box that the phone can draw over its camera preview."""

    label: str
    confidence: float
    x: float
    y: float
    width: float
    height: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "confidence": round(self.confidence, 3),
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "width": round(self.width, 4),
            "height": round(self.height, 4),
        }


@dataclass(frozen=True)
class CollisionResult:
    hazard: bool
    label: str = "object"
    confidence: float = 0.0
    detections: tuple[Detection, ...] = ()
    edge_map: str | None = None
    hazard_detection: Detection | None = None
    stair_direction: str | None = None


def stair_direction_for_label(label: str) -> str | None:
    """Map direction-specific stair classes to the phone haptic pattern."""
    normalized = label.casefold().replace("-", "_").replace(" ", "_")
    if normalized in {
        "stairs_up",
        "stair_up",
        "upstairs",
        "ascending_stairs",
        "up_stairs",
        "upward_stairs",
    }:
        return "up"
    if normalized in {
        "stairs_down",
        "stair_down",
        "downstairs",
        "descending_stairs",
        "down_stairs",
        "downward_stairs",
    }:
        return "down"
    return None


class CollisionDetector:
    async def detect(self, image_base64: str) -> CollisionResult:
        raise NotImplementedError


class YoloCollisionDetector(CollisionDetector):
    """YOLO nano detector with a conservative center/bottom collision heuristic.

    COCO labels alone do not provide depth. A detection is treated as a possible
    collision when it is a likely physical obstacle and occupies a meaningful
    part of the center/lower camera view.
    """

    HAZARD_LABELS = {
        "person",
        "bicycle",
        "car",
        "motorcycle",
        "bus",
        "truck",
        "train",
        "dog",
        "cat",
        "bench",
        "chair",
        "suitcase",
        "backpack",
        "skateboard",
        "stroller",
        # These labels are available in stair-aware/custom weights. The stock
        # COCO yolo11n weights do not include a stairs class.
        "stair",
        "stairs",
        "staircase",
        "stairway",
        "stairs_up",
        "stair_up",
        "upstairs",
        "ascending_stairs",
        "up_stairs",
        "upward_stairs",
        "stairs_down",
        "stair_down",
        "downstairs",
        "descending_stairs",
        "down_stairs",
        "downward_stairs",
    }

    def __init__(
        self,
        model_name: str = "yolo11n.pt",
        confidence: float = 0.45,
        image_size: int = 320,
        stair_model_name: str | None = None,
    ) -> None:
        self.model_name = model_name
        self.confidence = confidence
        self.image_size = image_size
        self.stair_model_name = stair_model_name
        self._model: Any | None = None
        self._import_error: Exception | None = None
        self._stair_model: Any | None = None
        self._stair_import_error: Exception | None = None

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        if self._import_error is not None:
            raise DetectorError(
                "YOLO is unavailable. Install server/requirements.txt."
            ) from self._import_error

        try:
            from ultralytics import YOLO

            self._model = YOLO(self.model_name)
            return self._model
        except Exception as exc:  # Includes missing package and model download errors.
            self._import_error = exc
            raise DetectorError(
                "YOLO could not load. Install server/requirements.txt and check "
                "the model download."
            ) from exc

    def _load_stair_model(self) -> Any:
        if self._stair_model is not None:
            return self._stair_model
        if self._stair_import_error is not None:
            raise DetectorError(
                "The stair model could not be loaded. Check DETECTOR_STAIR_MODEL."
            ) from self._stair_import_error
        if not self.stair_model_name:
            raise DetectorError("No stair model was configured")

        try:
            from ultralytics import YOLO

            self._stair_model = YOLO(self.stair_model_name)
            return self._stair_model
        except Exception as exc:
            self._stair_import_error = exc
            raise DetectorError(
                "The stair model could not be loaded. Check DETECTOR_STAIR_MODEL."
            ) from exc

    def _detect_sync(self, image_base64: str) -> CollisionResult:
        try:
            image_bytes = base64.b64decode(image_base64, validate=True)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except (binascii.Error, ValueError, OSError) as exc:
            raise DetectorError("Camera frame was not valid base64 image data") from exc

        edge_map = build_canny_edge_map(image)

        models = [self._load_model()]
        if self.stair_model_name and self.stair_model_name != self.model_name:
            models.append(self._load_stair_model())

        width, height = image.size
        best: CollisionResult | None = None
        detections: list[Detection] = []
        for model in models:
            try:
                results = model.predict(
                    source=image,
                    imgsz=self.image_size,
                    conf=self.confidence,
                    verbose=False,
                )
            except Exception as exc:
                raise DetectorError("YOLO failed to process the camera frame") from exc

            if not results:
                continue

            result = results[0]
            boxes = getattr(result, "boxes", None)
            names = getattr(result, "names", {})
            if boxes is None:
                continue

            for box in boxes:
                try:
                    class_id = int(box.cls[0].item())
                    confidence = float(box.conf[0].item())
                    x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
                except (AttributeError, IndexError, TypeError, ValueError):
                    continue

                try:
                    label = str(
                        names[class_id] if isinstance(names, dict) else names[class_id]
                    )
                except (KeyError, IndexError, TypeError):
                    continue

                box_width = max(0.0, x2 - x1)
                box_height = max(0.0, y2 - y1)
                detections.append(
                    Detection(
                        label=label,
                        confidence=confidence,
                        x=max(0.0, min(1.0, x1 / max(1.0, width))),
                        y=max(0.0, min(1.0, y1 / max(1.0, height))),
                        width=max(0.0, min(1.0, box_width / max(1.0, width))),
                        height=max(0.0, min(1.0, box_height / max(1.0, height))),
                    )
                )
                detection = detections[-1]
                if label.casefold() not in self.HAZARD_LABELS:
                    continue

                area_ratio = (box_width * box_height) / max(1.0, width * height)
                center_x = ((x1 + x2) / 2) / max(1.0, width)
                bottom_ratio = y2 / max(1.0, height)

                in_path = 0.15 <= center_x <= 0.85
                close_enough = area_ratio >= 0.08 or (
                    area_ratio >= 0.025 and bottom_ratio >= 0.82
                )
                if in_path and close_enough and (
                    best is None or confidence > best.confidence
                ):
                    best = CollisionResult(
                        True,
                        label,
                        confidence,
                        hazard_detection=detection,
                        stair_direction=stair_direction_for_label(label),
                    )

        if best is None:
            return CollisionResult(False, detections=tuple(detections), edge_map=edge_map)
        return CollisionResult(
            True,
            best.label,
            best.confidence,
            tuple(detections),
            edge_map,
            best.hazard_detection,
            best.stair_direction,
        )

    async def detect(self, image_base64: str) -> CollisionResult:
        return await asyncio.to_thread(self._detect_sync, image_base64)


class DisabledCollisionDetector(CollisionDetector):
    async def detect(self, image_base64: str) -> CollisionResult:
        return CollisionResult(False)


class MockCollisionDetector(CollisionDetector):
    async def detect(self, image_base64: str) -> CollisionResult:
        return CollisionResult(False)


def build_canny_edge_map(image: Image.Image, width: int = 160, height: int = 120) -> str | None:
    """Return Canny edges from the forward walking corridor.

    The trapezoid keeps the overlay focused on the lower-center path region and
    suppresses most ceiling, wall, and side-background edges. It is a cheap
    visual heuristic, not semantic walkable-surface segmentation.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None

    try:
        rgb = np.asarray(image.convert("RGB"))
        resized = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(resized, cv2.COLOR_RGB2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 60, 140)
        path_mask = np.zeros((height, width), dtype=np.uint8)
        corridor = np.array(
            [
                [int(width * 0.30), int(height * 0.36)],
                [int(width * 0.70), int(height * 0.36)],
                [int(width * 0.98), height - 1],
                [int(width * 0.02), height - 1],
            ],
            dtype=np.int32,
        )
        cv2.fillConvexPoly(path_mask, corridor, 255)
        edges = cv2.bitwise_and(edges, edges, mask=path_mask)
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[:, :, :3] = 255
        rgba[:, :, 3] = np.where(edges > 0, 190, 0).astype(np.uint8)
        encoded, png = cv2.imencode(".png", rgba)
        if not encoded:
            return None
        return base64.b64encode(png.tobytes()).decode("ascii")
    except (TypeError, ValueError, cv2.error):
        return None
