from __future__ import annotations

import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.vision import inspect_frame
from app.routing import create_walking_route

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
app = FastAPI(title="Wayfinder", version="1.0.0")
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")


class Origin(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class NavigationRequest(BaseModel):
    destination: str = Field(min_length=2, max_length=300)
    origin: Origin | None = None


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/healthz")
async def health() -> dict:
    return {
        "status": "ok",
        "vision_model": os.getenv("VISION_MODEL", "yolo11n.pt"),
        "navigation_provider": "OpenStreetMap pedestrian routing (no API key)",
    }


@app.post("/api/detect")
async def detect(frame: UploadFile = File(...)) -> dict:
    if frame.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "Upload a JPEG, PNG, or WebP camera frame.")
    image = await frame.read()
    if len(image) > 8_000_000:
        raise HTTPException(413, "Camera frame exceeds the 8 MB limit.")
    try:
        return await asyncio.to_thread(inspect_frame, image)
    except Exception as error:
        raise HTTPException(503, f"Vision model unavailable: {error}") from error


@app.post("/api/navigate")
async def navigate(request: NavigationRequest) -> dict:
    if not request.origin:
        raise HTTPException(400, "Location permission is required for live navigation.")
    try:
        return await asyncio.to_thread(
            create_walking_route, request.destination, request.origin.lat, request.origin.lng
        )
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    except Exception as error:
        raise HTTPException(502, "The public walking-route service is temporarily unavailable.") from error
