import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pathing import estimate_path
from speech import SpeechService, SPEECH_KEY, create_speech, get_speech


class PathTests(unittest.TestCase):
    def test_blank_has_no_invented_path(self):
        self.assertIsNone(estimate_path(Image.new('RGB', (320, 240))))

    def test_converging_boundaries(self):
        image = Image.new('RGB', (320, 240))
        draw = ImageDraw.Draw(image)
        draw.line([(30, 235), (125, 120)], fill='white', width=4)
        draw.line([(290, 235), (195, 120)], fill='white', width=4)
        path = estimate_path(image)
        self.assertIsNotNone(path)
        self.assertEqual(path['kind'], 'estimated_boundaries')
        self.assertTrue(all(0 <= v <= 1 for p in path['polygon'] for v in p))


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = SpeechService()
        self.service.key = ''
        app = web.Application()
        app[SPEECH_KEY] = self.service
        app.router.add_post('/speech', create_speech)
        app.router.add_get('/speech/{identifier}.mp3', get_speech)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.headers = {'Authorization': f'Bearer {self.service.token}'}

    async def asyncTearDown(self):
        await self.client.close()
        await self.service.close()

    async def test_authentication_and_validation(self):
        response = await self.client.post('/speech', json={'text': 'Hello'})
        self.assertEqual(response.status, 401)
        for body in ({'text': ''}, {'text': 'x' * 301}, []):
            response = await self.client.post('/speech', json=body, headers=self.headers)
            self.assertEqual(response.status, 400)

    async def test_unconfigured_cloud_requests_device_fallback(self):
        response = await self.client.post('/speech', json={'text': 'Chair detected.'}, headers=self.headers)
        self.assertEqual(response.status, 503)

    async def test_cached_audio_requires_token(self):
        self.service.cache['test'] = b'mp3 fixture'
        self.service.synthesize = AsyncMock(return_value='test')
        response = await self.client.post('/speech', json={'text': 'Chair'}, headers=self.headers)
        self.assertEqual((await response.json())['path'], '/speech/test.mp3')
        response = await self.client.get('/speech/test.mp3')
        self.assertEqual(response.status, 401)
        response = await self.client.get('/speech/test.mp3', headers=self.headers)
        self.assertEqual(await response.read(), b'mp3 fixture')

    async def test_busy_does_not_queue_more_synthesis(self):
        async with self.service.lock:
            response = await self.client.post('/speech', json={'text': 'Chair'}, headers=self.headers)
            self.assertEqual(response.status, 429)
