"""Local obstacle detection and intentionally conservative warning policy."""
from __future__ import annotations

import io
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

WARNING_CLASSES = {
    "person", "bicycle", "car", "motorcycle", "bus", "truck", "bench", "chair",
    "stop sign", "fire hydrant", "dog", "cat", "backpack", "suitcase",
}


@dataclass
class VisionSettings:
    model: str = os.getenv("VISION_MODEL", "yolo11n.pt")
    confidence: float = float(os.getenv("WARNING_CONFIDENCE", "0.45"))
    near_fraction: float = float(os.getenv("NEAR_FRAME_FRACTION", "0.12"))
    critical_fraction: float = float(os.getenv("CRITICAL_FRAME_FRACTION", "0.28"))


@lru_cache(maxsize=1)
def model() -> Any:
    # Imports lazily so the health endpoint and UI remain usable while the model is unavailable.
    # Desktop sandboxes can deny %APPDATA%; keep Ultralytics' local settings beside this app.
    config_dir = Path(__file__).resolve().parents[1] / "work" / "ultralytics"
    config_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config_dir))
    from ultralytics import YOLO
    return YOLO(VisionSettings().model)


def inspect_frame(image_bytes: bytes) -> dict[str, Any]:
    settings = VisionSettings()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    frame = np.asarray(image)
    height, width = frame.shape[:2]
    result = model()(frame, conf=settings.confidence, verbose=False)[0]
    detections: list[dict[str, Any]] = []

    for box in result.boxes:
        label = result.names[int(box.cls[0])]
        confidence = round(float(box.conf[0]), 3)
        x1, y1, x2, y2 = [max(0, int(v)) for v in box.xyxy[0].tolist()]
        fraction = ((x2 - x1) * (y2 - y1)) / (width * height)
        # Center-weight avoids alerting on a distant item at the far edge as aggressively.
        center_x = (x1 + x2) / 2 / width
        center_weight = max(0.35, 1 - abs(center_x - 0.5))
        risk = fraction * center_weight if label in WARNING_CLASSES else 0
        detections.append({
            "label": label, "confidence": confidence, "frame_fraction": round(fraction, 4),
            "risk": round(risk, 4), "box": [x1, y1, x2, y2],
        })

    detections.sort(key=lambda item: item["risk"], reverse=True)
    primary = detections[0] if detections else None
    if not primary or primary["risk"] < settings.near_fraction:
        warning = {"level": "clear", "message": "Path appears clear"}
    elif primary["risk"] >= settings.critical_fraction:
        warning = {"level": "critical", "message": f"Stop: {primary['label']} very close"}
    else:
        warning = {"level": "warning", "message": f"Caution: {primary['label']} ahead"}
    return {"warning": warning, "detections": detections[:8], "frame": {"width": width, "height": height}}
