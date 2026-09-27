"""Text-to-speech providers used by the phone alert pipeline."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

import aiohttp


class TTSError(RuntimeError):
    """Raised when a text-to-speech provider cannot synthesize audio."""


@dataclass(frozen=True)
class TTSResult:
    audio_base64: str
    mime_type: str = "audio/mpeg"


class TTSProvider:
    async def synthesize(self, text: str) -> TTSResult:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class DisabledTTSProvider(TTSProvider):
    async def synthesize(self, text: str) -> TTSResult:
        raise TTSError("ElevenLabs TTS is disabled")


class ElevenLabsTTSProvider(TTSProvider):
    """Synthesize short alert messages with the ElevenLabs REST API.

    The API key remains on the laptop/server. Only the resulting short audio
    payload is sent over the existing phone WebSocket connection.
    """

    def __init__(
        self,
        api_key: str | None = None,
        voice_id: str | None = None,
        model_id: str | None = None,
        timeout_seconds: float = 15,
    ) -> None:
        self.api_key = (api_key or os.getenv("ELEVENLABS_API_KEY", "")).strip()
        self.voice_id = (
            voice_id or os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
        ).strip()
        self.model_id = (
            model_id
            or os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
        ).strip()
        self.endpoint = (
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}"
        )
        self.timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self.session: aiohttp.ClientSession | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.voice_id)

    async def synthesize(self, text: str) -> TTSResult:
        if not self.enabled:
            raise TTSError(
                "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to enable ElevenLabs TTS"
            )
        if not text.strip():
            raise TTSError("Cannot synthesize an empty message")

        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=self.timeout)

        payload = {
            "text": text[:500],
            "model_id": self.model_id,
            "voice_settings": {
                "stability": 0.55,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }
        headers = {
            "xi-api-key": self.api_key,
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
        }
        try:
            async with self.session.post(
                self.endpoint,
                params={"output_format": "mp3_44100_128"},
                headers=headers,
                json=payload,
            ) as response:
                if response.status >= 400:
                    detail = (await response.text())[:240]
                    raise TTSError(f"ElevenLabs HTTP {response.status}: {detail}")
                audio = await response.read()
        except aiohttp.ClientError as exc:
            raise TTSError("Cannot reach ElevenLabs; using phone speech fallback") from exc

        if not audio:
            raise TTSError("ElevenLabs returned an empty audio response")
        return TTSResult(base64.b64encode(audio).decode("ascii"))

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()
            self.session = None
