import json
import sys
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from main import DistanceReading, create_app, parse_serial_line
from detector import CollisionDetector, CollisionResult
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
        return CollisionResult(True, "person", 0.91)


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
            self.assertEqual(warning["message"], "Person ahead.")
            alert = await websocket.receive_json()
            self.assertEqual(alert, {
                "type": "alert",
                "source": "detector",
                "message": "Person ahead.",
            })
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
