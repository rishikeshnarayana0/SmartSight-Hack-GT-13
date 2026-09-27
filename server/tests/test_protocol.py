import json
import sys
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from main import (
    DistanceReading,
    avoidance_instruction,
    create_app,
    obstacle_instruction,
    parse_serial_line,
)
from detector import CollisionDetector, CollisionResult, Detection
from navigation import RoutePlan, RouteStep
from vision import VisionProvider, VisionResult, parse_vision_output


class ParseSerialLineTests(unittest.TestCase):
    def test_parses_distance_message(self) -> None:
        line = json.dumps({"type": "distance", "cm": 42.1, "hazard": True})
        self.assertEqual(parse_serial_line(line), DistanceReading(42.1, True))

    def test_ignores_startup_and_invalid_messages(self) -> None:
        self.assertIsNone(parse_serial_line("hardware ready"))
        self.assertIsNone(parse_serial_line('{"type":"debug"}'))
        self.assertIsNone(
            parse_serial_line('{"type":"distance","cm":-1,"hazard":true}')
        )
        self.assertIsNone(
            parse_serial_line('{"type":"distance","cm":20,"hazard":"yes"}')
        )

    def test_parses_model_json_with_markdown_fence(self) -> None:
        result = parse_vision_output(
            '```json\n{"hazard": true, "message": "Step left."}\n```'
        )
        self.assertEqual(result, VisionResult(True, "Step left."))
        self.assertEqual(
            parse_vision_output("No hazard detected; the path is clear."),
            VisionResult(False, "Path appears clear."),
        )


class FakeVisionProvider(VisionProvider):
    async def infer(self, image_base64: str) -> VisionResult:
        return VisionResult(True, "Obstacle directly ahead.")


class FakeCollisionDetector(CollisionDetector):
    async def detect(self, image_base64: str) -> CollisionResult:
        return CollisionResult(
            True,
            "person",
            0.91,
            detections=(Detection("person", 0.91, 0.05, 0.35, 0.2, 0.5),),
        )


class AvoidanceInstructionTests(unittest.TestCase):
    def test_upward_stairs_instruction_says_to_climb(self) -> None:
        collision = CollisionResult(
            True,
            "stairs",
            0.9,
            detections=(Detection("stairs", 0.9, 0.2, 0.35, 0.6, 0.5),),
            stair_direction="up",
        )
        self.assertEqual(
            obstacle_instruction(collision),
            "Upward stairs ahead. Climb carefully.",
        )

    def test_downward_stairs_instruction_says_to_descend(self) -> None:
        collision = CollisionResult(
            True,
            "stairs_down",
            0.9,
            detections=(Detection("stairs_down", 0.9, 0.2, 0.35, 0.6, 0.5),),
            stair_direction="down",
        )
        self.assertEqual(
            obstacle_instruction(collision),
            "Downward stairs ahead. Descend carefully.",
        )

    def test_moves_away_from_left_side_obstacle(self) -> None:
        collision = CollisionResult(
            True,
            "person",
            0.9,
            detections=(Detection("person", 0.9, 0.05, 0.3, 0.2, 0.5),),
        )
        self.assertEqual(
            avoidance_instruction(collision),
            "Move right, then continue straight.",
        )

    def test_moves_away_from_right_side_obstacle(self) -> None:
        collision = CollisionResult(
            True,
            "chair",
            0.9,
            detections=(Detection("chair", 0.9, 0.75, 0.3, 0.2, 0.5),),
        )
        self.assertEqual(
            avoidance_instruction(collision),
            "Move left, then continue straight.",
        )


class FakeNavigation:
    async def plan(self, latitude: float, longitude: float, destination: str) -> RoutePlan:
        return RoutePlan(
            destination=destination,
            distance_m=120.0,
            duration_s=90.0,
            steps=(
                RouteStep("Start walking.", 80.0, 0.0, latitude, longitude),
                RouteStep("Turn right.", 40.0, 80.0, latitude + 0.001, longitude + 0.001),
            ),
        )

    async def close(self) -> None:
        return None


class WebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = TestClient(TestServer(create_app()))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_health_and_demo_alert(self) -> None:
        response = await self.client.get("/health")
        self.assertEqual(await response.json(), {"ok": True, "clients": 0})

        websocket = await self.client.ws_connect("/ws")
        connected = await websocket.receive_json()
        self.assertEqual(
            connected,
            {"type": "status", "message": "connected", "vlm_enabled": False},
        )

        await websocket.send_json({"type": "demo_alert"})
        alert = await websocket.receive_json()
        self.assertEqual(alert["type"], "alert")
        self.assertEqual(alert["source"], "demo")
        await websocket.close()

    async def test_phone_frame_runs_vision_and_emits_alert(self) -> None:
        client = TestClient(
            TestServer(
                create_app(
                    vision_provider=FakeVisionProvider(),
                    detector=FakeCollisionDetector(),
                )
            )
        )
        await client.start_server()
        try:
            websocket = await client.ws_connect("/ws")
            await websocket.receive_json()  # connected status
            await websocket.send_json(
                {"type": "frame", "id": "frame-1", "image": "base64-jpeg"}
            )

            result = await websocket.receive_json()
            self.assertEqual(result["type"], "detector_result")
            self.assertTrue(result["hazard"])

            warning = await websocket.receive_json()
            self.assertEqual(warning["type"], "collision_warning")

            busy = await websocket.receive_json()
            self.assertEqual(busy, {"type": "pipeline_state", "state": "busy"})

            vision = await websocket.receive_json()
            self.assertEqual(vision["type"], "vision_result")
            self.assertTrue(vision["hazard"])

            alert = await websocket.receive_json()
            self.assertEqual(alert["source"], "vision")
            self.assertEqual(alert["message"], "Obstacle directly ahead.")

            idle = await websocket.receive_json()
            self.assertEqual(idle, {"type": "pipeline_state", "state": "idle"})
            await websocket.close()
        finally:
            await client.close()

    async def test_yolo_only_mode_speaks_detector_label_without_vlm(self) -> None:
        client = TestClient(TestServer(create_app(detector=FakeCollisionDetector())))
        await client.start_server()
        try:
            websocket = await client.ws_connect("/ws")
            connected = await websocket.receive_json()
            self.assertFalse(connected["vlm_enabled"])
            await websocket.send_json(
                {"type": "frame", "id": "frame-1", "image": "base64-jpeg"}
            )
            self.assertEqual((await websocket.receive_json())["type"], "detector_result")
            warning = await websocket.receive_json()
            self.assertEqual(
                warning["message"],
                "Person detected. Move right, then continue straight.",
            )
            alert = await websocket.receive_json()
            self.assertEqual(alert, {
                "type": "alert",
                "source": "detector",
                "message": "Person detected. Move right, then continue straight.",
            })

            await websocket.send_json(
                {"type": "frame", "id": "frame-2", "image": "base64-jpeg"}
            )
            throttled = await websocket.receive_json()
            self.assertEqual(throttled["type"], "detector_result")
            self.assertFalse(throttled["warning_emitted"])
        finally:
            await client.close()

    async def test_route_start_returns_step_by_step_plan(self) -> None:
        client = TestClient(TestServer(create_app(navigation=FakeNavigation())))
        await client.start_server()
        try:
            websocket = await client.ws_connect("/ws")
            await websocket.receive_json()
            await websocket.send_json(
                {
                    "type": "route_start",
                    "destination": "Student Center",
                    "latitude": 33.7756,
                    "longitude": -84.3963,
                }
            )
            response = await websocket.receive_json()
            self.assertEqual(response["type"], "route_plan")
            self.assertEqual(response["route"]["destination"], "Student Center")
            self.assertEqual(response["route"]["steps"][1]["instruction"], "Turn right.")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
