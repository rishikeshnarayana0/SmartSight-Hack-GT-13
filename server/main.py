"""Small WebSocket server and optional USB-serial bridge."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from aiohttp import WSMsgType, web

try:
    from .vision import (
        DisabledVisionProvider,
        MockVisionProvider,
        OllamaVisionProvider,
        VisionError,
        VisionProvider,
    )
except ImportError:  # Supports `python server/main.py` from the project root.
    from vision import (
        DisabledVisionProvider,
        MockVisionProvider,
        OllamaVisionProvider,
        VisionError,
        VisionProvider,
    )

try:
    from .detector import (
        CollisionDetector,
        CollisionResult,
        DetectorError,
        DisabledCollisionDetector,
        MockCollisionDetector,
        YoloCollisionDetector,
    )
except ImportError:  # Supports `python server/main.py` from the project root.
    from detector import (
        CollisionDetector,
        CollisionResult,
        DetectorError,
        DisabledCollisionDetector,
        MockCollisionDetector,
        YoloCollisionDetector,
    )

try:
    from .navigation import NavigationError, NavigationService
except ImportError:  # Supports `python server/main.py` from the project root.
    from navigation import NavigationError, NavigationService

try:
    import serial
except ImportError:  # Allows protocol tests to run before dependencies are installed.
    serial = None


@dataclass(frozen=True)
class DistanceReading:
    centimeters: float
    hazard: bool


@dataclass
class PipelineState:
    vlm_busy: bool = False
    last_collision_at: float = 0.0


def parse_serial_line(line: str) -> DistanceReading | None:
    """Parse one firmware JSON line; ignore startup text and malformed input."""
    try:
        payload = json.loads(line)
        if payload.get("type") != "distance":
            return None
        centimeters = float(payload["cm"])
        hazard = payload["hazard"]
        if not isinstance(hazard, bool) or centimeters < 0:
            return None
        return DistanceReading(centimeters=centimeters, hazard=hazard)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


class Hub:
    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()

    async def broadcast(self, payload: dict[str, Any]) -> None:
        stale: list[web.WebSocketResponse] = []
        for client in self.clients:
            try:
                await client.send_json(payload)
            except (ConnectionError, RuntimeError):
                stale.append(client)
        self.clients.difference_update(stale)


HUB_KEY = web.AppKey("hub", Hub)
SERIAL_TASK_KEY = web.AppKey("serial_task", asyncio.Task[None])
VISION_PROVIDER_KEY = web.AppKey("vision_provider", VisionProvider)
VISION_ENABLED_KEY = web.AppKey("vision_enabled", bool)
DETECTOR_KEY = web.AppKey("detector", CollisionDetector)
INFERENCE_LOCK_KEY = web.AppKey("inference_lock", asyncio.Lock)
DETECTOR_LOCK_KEY = web.AppKey("detector_lock", asyncio.Lock)
PIPELINE_STATE_KEY = web.AppKey("pipeline_state", PipelineState)
NAVIGATION_KEY = web.AppKey("navigation", NavigationService)

COLLISION_WARNING_INTERVAL_SECONDS = 2.0


async def handle_phone_message(
    websocket: web.WebSocketResponse,
    app: web.Application,
    payload: dict[str, Any],
) -> None:
    hub = app[HUB_KEY]
    message_type = payload.get("type")

    if message_type == "route_start":
        destination = payload.get("destination")
        latitude = payload.get("latitude")
        longitude = payload.get("longitude")
        if (
            not isinstance(destination, str)
            or not destination.strip()
            or not isinstance(latitude, (int, float))
            or not isinstance(longitude, (int, float))
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
        ):
            await websocket.send_json(
                {"type": "route_error", "message": "Destination and location are required."}
            )
            return

        try:
            route = await app[NAVIGATION_KEY].plan(
                float(latitude), float(longitude), destination
            )
        except NavigationError as exc:
            await websocket.send_json({"type": "route_error", "message": str(exc)})
            return

        await websocket.send_json({"type": "route_plan", "route": route.as_dict()})
        return

    if message_type == "frame":
        frame_id = str(payload.get("id", ""))
        image = payload.get("image")
        if not frame_id or not isinstance(image, str) or not image:
            await websocket.send_json({"type": "error", "message": "Invalid frame"})
            return

        state = app[PIPELINE_STATE_KEY]
        if state.vlm_busy:
            await websocket.send_json({"type": "pipeline_busy", "id": frame_id})
            return

        # YOLO is the fast gate. It runs on every phone frame; the VLM only runs
        # when the detector sees a possible collision.
        detector_lock = app[DETECTOR_LOCK_KEY]
        async with detector_lock:
            try:
                collision = await app[DETECTOR_KEY].detect(image)
            except DetectorError as exc:
                await websocket.send_json(
                    {"type": "detector_error", "id": frame_id, "message": str(exc)}
                )
                return

        await websocket.send_json(
            {
                "type": "detector_result",
                "id": frame_id,
                "hazard": collision.hazard,
                "label": collision.label,
                "confidence": round(collision.confidence, 3),
            }
        )

        if not collision.hazard:
            state.last_collision_at = 0.0
            return

        now = time.monotonic()
        if now - state.last_collision_at < COLLISION_WARNING_INTERVAL_SECONDS:
            return
        state.last_collision_at = now

        detector_message = f"{collision.label.capitalize()} ahead."

        # The detector warning is immediate and throttled. In YOLO-only mode,
        # this is also the complete spoken output; the VLM is optional.
        await hub.broadcast(
            {
                "type": "collision_warning",
                "source": "detector",
                "label": collision.label,
                "message": detector_message,
            }
        )

        if not app[VISION_ENABLED_KEY]:
            await hub.broadcast(
                {
                    "type": "alert",
                    "source": "detector",
                    "message": detector_message,
                }
            )
            return

        state.vlm_busy = True
        await hub.broadcast({"type": "pipeline_state", "state": "busy"})
        inference_lock = app[INFERENCE_LOCK_KEY]
        try:
            # Keep at most one model request in flight. The phone also pauses
            # capture on pipeline_state=busy, so no second image is taken.
            async with inference_lock:
                try:
                    result = await app[VISION_PROVIDER_KEY].infer(image)
                except VisionError as exc:
                    await hub.broadcast(
                        {
                            "type": "inference_error",
                            "id": frame_id,
                            "message": str(exc),
                        }
                    )
                    return

            await hub.broadcast(
                {
                    "type": "vision_result",
                    "id": frame_id,
                    "hazard": result.hazard,
                    "message": result.message,
                }
            )
            await hub.broadcast(
                {
                    "type": "alert",
                    "source": "vision",
                    "message": result.message,
                }
            )
        finally:
            state.vlm_busy = False
            await hub.broadcast({"type": "pipeline_state", "state": "idle"})
        return

    if message_type == "demo_alert":
        await hub.broadcast(
            {
                "type": "alert",
                "source": "demo",
                "message": "Test obstacle detected ahead.",
            }
        )
        return

    if message_type == "ping":
        await websocket.send_json({"type": "pong"})
        return

    await websocket.send_json({"type": "error", "message": "Unknown message type"})


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    hub = request.app[HUB_KEY]
    websocket = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await websocket.prepare(request)
    hub.clients.add(websocket)
    await websocket.send_json(
        {
            "type": "status",
            "message": "connected",
            "vlm_enabled": request.app[VISION_ENABLED_KEY],
        }
    )

    try:
        async for message in websocket:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    await websocket.send_json(
                        {"type": "error", "message": "Message must be JSON"}
                    )
                    continue
                if not isinstance(payload, dict):
                    await websocket.send_json(
                        {"type": "error", "message": "Message must be an object"}
                    )
                    continue
                await handle_phone_message(websocket, request.app, payload)
            elif message.type == WSMsgType.ERROR:
                break
    finally:
        hub.clients.discard(websocket)

    return websocket


async def health_handler(request: web.Request) -> web.Response:
    hub = request.app[HUB_KEY]
    return web.json_response({"ok": True, "clients": len(hub.clients)})


async def serial_bridge(hub: Hub, port: str, baud_rate: int) -> None:
    if serial is None:
        raise RuntimeError("pyserial is required when --serial-port is used")

    print(f"Opening hardware on {port} at {baud_rate} baud")
    connection = serial.Serial(port, baud_rate, timeout=1)
    previous_hazard = False

    try:
        while True:
            raw_line = await asyncio.to_thread(connection.readline)
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", errors="replace").strip()
            reading = parse_serial_line(line)
            if reading is None:
                print(f"Hardware: {line}")
                continue

            await hub.broadcast(
                {
                    "type": "distance",
                    "cm": round(reading.centimeters, 1),
                    "hazard": reading.hazard,
                }
            )

            if reading.hazard and not previous_hazard:
                await hub.broadcast(
                    {
                        "type": "alert",
                        "source": "hardware",
                        "message": (
                            f"Obstacle {round(reading.centimeters)} centimeters ahead."
                        ),
                    }
                )
            previous_hazard = reading.hazard
    finally:
        connection.close()


def create_app(
    serial_port: str | None = None,
    baud_rate: int = 115_200,
    vision_provider: VisionProvider | None = None,
    detector: CollisionDetector | None = None,
    vision_enabled: bool | None = None,
    navigation: NavigationService | None = None,
) -> web.Application:
    app = web.Application(client_max_size=4 * 1024 * 1024)
    app[HUB_KEY] = Hub()
    app[VISION_PROVIDER_KEY] = vision_provider or DisabledVisionProvider()
    app[VISION_ENABLED_KEY] = (
        vision_enabled
        if vision_enabled is not None
        else not isinstance(app[VISION_PROVIDER_KEY], DisabledVisionProvider)
    )
    app[DETECTOR_KEY] = detector or YoloCollisionDetector()
    app[INFERENCE_LOCK_KEY] = asyncio.Lock()
    app[DETECTOR_LOCK_KEY] = asyncio.Lock()
    app[PIPELINE_STATE_KEY] = PipelineState()
    app[NAVIGATION_KEY] = navigation or NavigationService()
    app.router.add_get("/health", health_handler)
    app.router.add_get("/ws", websocket_handler)

    async def start_background_tasks(application: web.Application) -> None:
        if serial_port:
            application[SERIAL_TASK_KEY] = asyncio.create_task(
                serial_bridge(application[HUB_KEY], serial_port, baud_rate)
            )

    async def stop_background_tasks(application: web.Application) -> None:
        task = application.get(SERIAL_TASK_KEY)
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await application[VISION_PROVIDER_KEY].close()
        await application[NAVIGATION_KEY].close()

    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(stop_background_tasks)
    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--serial-port")
    parser.add_argument("--baud-rate", default=115_200, type=int)
    parser.add_argument(
        "--vision-provider",
        choices=("ollama", "mock", "off"),
        default=os.getenv("VISION_PROVIDER", "off"),
    )
    parser.add_argument(
        "--vision-url",
        default=os.getenv("VISION_URL", "http://127.0.0.1:11434"),
    )
    parser.add_argument(
        "--vision-model",
        default=os.getenv("VISION_MODEL", "qwen2.5vl:3b"),
    )
    parser.add_argument(
        "--detector",
        choices=("yolo", "mock", "off"),
        default=os.getenv("DETECTOR", "yolo"),
    )
    parser.add_argument(
        "--detector-model",
        default=os.getenv("DETECTOR_MODEL", "yolo11n.pt"),
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    providers: dict[str, VisionProvider] = {
        "ollama": OllamaVisionProvider(args.vision_url, args.vision_model),
        "mock": MockVisionProvider(),
        "off": DisabledVisionProvider(),
    }
    detectors: dict[str, CollisionDetector] = {
        "yolo": YoloCollisionDetector(args.detector_model),
        "mock": MockCollisionDetector(),
        "off": DisabledCollisionDetector(),
    }
    print(
        f"Server listening on http://{args.host}:{args.port} "
        f"(detector: {args.detector}, vision provider: {args.vision_provider})"
    )
    web.run_app(
        create_app(
            args.serial_port,
            args.baud_rate,
            providers[args.vision_provider],
            detectors[args.detector],
            vision_enabled=args.vision_provider != "off",
        ),
        host=args.host,
        port=args.port,
        shutdown_timeout=2,
        print=None,
    )
