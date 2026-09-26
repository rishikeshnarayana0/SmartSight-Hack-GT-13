"""Small, provider-agnostic vision inference adapter.

The default provider talks to a local Ollama server. Keeping this boundary
small makes it possible to swap in another OpenAI-compatible or local model
without changing the WebSocket protocol or the phone app.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

import aiohttp


class VisionError(RuntimeError):
    """Raised when a vision provider cannot produce a result."""


@dataclass(frozen=True)
class VisionResult:
    hazard: bool
    message: str


def parse_vision_output(text: str) -> VisionResult:
    """Parse the model's JSON, tolerating markdown fences and extra prose."""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)

    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if match:
        try:
            data: Any = json.loads(match.group(0))
            if isinstance(data, dict) and isinstance(data.get("hazard"), bool):
                message = str(data.get("message") or "Potential hazard ahead.")
                return VisionResult(hazard=data["hazard"], message=message[:240])
        except json.JSONDecodeError:
            pass

    lowered = cleaned.lower()
    if any(
        phrase in lowered
        for phrase in ("no hazard", "path is clear", "path appears clear", "safe")
    ) and "unsafe" not in lowered:
        return VisionResult(False, "Path appears clear.")
    if any(word in lowered for word in ("hazard", "obstacle", "danger")):
        return VisionResult(True, "Potential hazard ahead.")
    raise VisionError("Vision model returned an unreadable result")


class VisionProvider:
    async def infer(self, image_base64: str) -> VisionResult:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class OllamaVisionProvider(VisionProvider):
    """Run image inference through Ollama's local /api/generate endpoint."""

    PROMPT = (
        "Look at this camera frame for a person who cannot rely on vision. "
        "Identify a nearby obstacle, vehicle, drop-off, stair, door, or other "
        "immediate navigation hazard. Be conservative but do not invent one. "
        "Reply with JSON only: {\"hazard\": true or false, "
        "\"message\": \"a short spoken instruction under 15 words\"}."
    )

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "qwen2.5vl:3b",
        timeout_seconds: float = 45,
    ) -> None:
        self.endpoint = f"{base_url.rstrip('/')}/api/generate"
        self.model = model
        self.timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self.session: aiohttp.ClientSession | None = None

    async def infer(self, image_base64: str) -> VisionResult:
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=self.timeout)

        payload = {
            "model": self.model,
            "prompt": self.PROMPT,
            "images": [image_base64],
            "stream": False,
            "format": "json",
        }
        try:
            async with self.session.post(self.endpoint, json=payload) as response:
                if response.status >= 400:
                    detail = (await response.text())[:240]
                    raise VisionError(f"Ollama HTTP {response.status}: {detail}")
                body = await response.json()
        except aiohttp.ClientError as exc:
            raise VisionError(
                "Cannot reach Ollama. Start it and pull the configured vision model."
            ) from exc

        raw_result = body.get("response") if isinstance(body, dict) else None
        if not isinstance(raw_result, str):
            raise VisionError("Ollama response did not contain text")
        return parse_vision_output(raw_result)

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()
            self.session = None


class DisabledVisionProvider(VisionProvider):
    async def infer(self, image_base64: str) -> VisionResult:
        raise VisionError("Vision inference is disabled")


class MockVisionProvider(VisionProvider):
    """Deterministic provider for local protocol tests and UI smoke tests."""

    async def infer(self, image_base64: str) -> VisionResult:
        return VisionResult(False, "Path appears clear.")
