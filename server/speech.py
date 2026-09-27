"""Optional server-side ElevenLabs synthesis, with bounded in-memory caching."""
import asyncio
import hashlib
import os
import secrets
from collections import OrderedDict

import aiohttp
from aiohttp import web


class SpeechService:
    def __init__(self):
        self.key = os.getenv("ELEVENLABS_API_KEY", "")
        self.voice = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
        self.model = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")
        self.token = secrets.token_urlsafe(32)
        self.cache = OrderedDict()
        self.lock = asyncio.Lock()
        self.session = None

    async def synthesize(self, text):
        if not self.key:
            raise web.HTTPServiceUnavailable(text="Use device speech")
        identifier = hashlib.sha256(f"{self.voice}:{self.model}:{text}".encode()).hexdigest()
        async with self.lock:
            if identifier in self.cache:
                self.cache.move_to_end(identifier)
                return identifier
            if self.session is None:
                self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4))
            try:
                async with self.session.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice}",
                    params={"output_format": "mp3_44100_128"},
                    headers={"xi-api-key": self.key},
                    json={"text": text, "model_id": self.model},
                ) as response:
                    if response.status != 200:
                        raise web.HTTPServiceUnavailable(text="Use device speech")
                    chunks = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        chunks.extend(chunk)
                        if len(chunks) > 2_000_000:
                            raise web.HTTPServiceUnavailable(text="Invalid speech response")
                    audio = bytes(chunks)
                    if not audio:
                        raise web.HTTPServiceUnavailable(text="Invalid speech response")
            except (aiohttp.ClientError, asyncio.TimeoutError):
                raise web.HTTPServiceUnavailable(text="Use device speech")
            self.cache[identifier] = audio
            while len(self.cache) > 48:
                self.cache.popitem(last=False)
            return identifier

    async def close(self):
        if self.session:
            await self.session.close()


SPEECH_KEY = web.AppKey("speech", SpeechService)


async def create_speech(request):
    service = request.app[SPEECH_KEY]
    if request.headers.get("Authorization") != f"Bearer {service.token}":
        raise web.HTTPUnauthorized()
    if service.lock.locked():
        raise web.HTTPTooManyRequests(text="Speech busy; use device speech")
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest()
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 300:
        raise web.HTTPBadRequest(text="Speech must contain 1–300 characters")
    identifier = await service.synthesize(text.strip())
    return web.json_response({"path": f"/speech/{identifier}.mp3"})


async def get_speech(request):
    service = request.app[SPEECH_KEY]
    if request.headers.get("Authorization") != f"Bearer {service.token}":
        raise web.HTTPUnauthorized()
    audio = service.cache.get(request.match_info["identifier"])
    if audio is None:
        raise web.HTTPNotFound()
    return web.Response(body=audio, content_type="audio/mpeg")
