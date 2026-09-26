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
class CollisionResult:
    hazard: bool
    label: str = "object"
    confidence: float = 0.0


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
    }

    def __init__(
        self,
        model_name: str = "yolo11n.pt",
        confidence: float = 0.45,
        image_size: int = 320,
    ) -> None:
        self.model_name = model_name
        self.confidence = confidence
        self.image_size = image_size
        self._model: Any | None = None
        self._import_error: Exception | None = None

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

    def _detect_sync(self, image_base64: str) -> CollisionResult:
        try:
            image_bytes = base64.b64decode(image_base64, validate=True)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except (binascii.Error, ValueError, OSError) as exc:
            raise DetectorError("Camera frame was not valid base64 image data") from exc

        model = self._load_model()
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
            return CollisionResult(False)

        result = results[0]
        boxes = getattr(result, "boxes", None)
        names = getattr(result, "names", {})
        if boxes is None:
            return CollisionResult(False)

        width, height = image.size
        best: CollisionResult | None = None
        for box in boxes:
            try:
                class_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
            except (AttributeError, IndexError, TypeError, ValueError):
                continue

            label = str(names[class_id] if isinstance(names, dict) else names[class_id])
            if label not in self.HAZARD_LABELS:
                continue

            box_width = max(0.0, x2 - x1)
            box_height = max(0.0, y2 - y1)
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
                best = CollisionResult(True, label, confidence)

        return best or CollisionResult(False)

    async def detect(self, image_base64: str) -> CollisionResult:
        return await asyncio.to_thread(self._detect_sync, image_base64)


class DisabledCollisionDetector(CollisionDetector):
    async def detect(self, image_base64: str) -> CollisionResult:
        return CollisionResult(False)


class MockCollisionDetector(CollisionDetector):
    async def detect(self, image_base64: str) -> CollisionResult:
        return CollisionResult(False)

