"""Keyless, low-volume pedestrian navigation using public OpenStreetMap services."""
from __future__ import annotations

import json
import math
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = "Wayfinder-assistive-navigation/1.0 (local educational project)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
FOOT_ROUTER_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving"
_cache: dict[str, list[dict]] = {}
_nominatim_lock = threading.Lock()
_last_nominatim_request = 0.0


def _get_json(url: str) -> dict | list:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _search(destination: str, origin_lat: float, origin_lng: float) -> dict:
    global _last_nominatim_request
    cache_key = f"{destination.casefold().strip()}:{origin_lat:.3f}:{origin_lng:.3f}"
    if cache_key not in _cache:
        params = {
            "format": "jsonv2", "limit": 8, "addressdetails": 1, "q": destination,
            "viewbox": f"{origin_lng - .35},{origin_lat + .25},{origin_lng + .35},{origin_lat - .25}",
            "bounded": 0,
        }
        with _nominatim_lock:
            wait = 1.05 - (time.monotonic() - _last_nominatim_request)
            if wait > 0:
                time.sleep(wait)
            results = _get_json(f"{NOMINATIM_URL}?{urlencode(params)}")
            _last_nominatim_request = time.monotonic()
        _cache[cache_key] = results
    results = _cache[cache_key]
    if not results:
        raise ValueError("No matching destination was found.")
    ranked = sorted(
        results,
        key=lambda item: _distance_m(origin_lat, origin_lng, float(item["lat"]), float(item["lon"])),
    )
    selected = ranked[0]
    return {
        "name": selected.get("name") or destination,
        "display_name": selected["display_name"],
        "lat": float(selected["lat"]),
        "lng": float(selected["lon"]),
        "distance_from_user_m": round(_distance_m(origin_lat, origin_lng, float(selected["lat"]), float(selected["lon"]))),
    }


def _instruction(step: dict, destination_name: str) -> str:
    maneuver = step.get("maneuver", {})
    kind = maneuver.get("type", "continue")
    modifier = (maneuver.get("modifier") or "").replace("slight ", "slightly ")
    road = step.get("name") or "the path"
    if kind == "depart":
        text = f"Start on {road}"
    elif kind == "arrive":
        return f"You have arrived at {destination_name}."
    elif kind in {"turn", "end of road", "fork", "off ramp", "on ramp"}:
        text = f"Turn {modifier} onto {road}" if modifier else f"Turn onto {road}"
    elif kind in {"roundabout", "rotary", "roundabout turn"}:
        exit_number = maneuver.get("exit")
        text = f"Enter the roundabout{f' and take exit {exit_number}' if exit_number else ''} onto {road}"
    elif kind in {"new name", "continue", "notification"}:
        text = f"Continue {modifier} on {road}" if modifier else f"Continue on {road}"
    else:
        text = f"Proceed {modifier} on {road}" if modifier else f"Proceed on {road}"
    return text.replace("  ", " ").strip() + "."


def create_walking_route(destination: str, origin_lat: float, origin_lng: float) -> dict:
    selected = _search(destination, origin_lat, origin_lng)
    coords = f"{origin_lng},{origin_lat};{selected['lng']},{selected['lat']}"
    params = urlencode({"steps": "true", "overview": "full", "geometries": "geojson"})
    payload = _get_json(f"{FOOT_ROUTER_URL}/{coords}?{params}")
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise ValueError("No pedestrian route was found to that destination.")
    route = payload["routes"][0]
    raw_steps = route["legs"][0]["steps"]
    steps = []
    for index, step in enumerate(raw_steps):
        lon, lat = step["maneuver"]["location"]
        steps.append({
            "index": index,
            "instruction": _instruction(step, selected["name"]),
            "distance_m": round(step.get("distance", 0)),
            "duration_s": round(step.get("duration", 0)),
            "location": {"lat": lat, "lng": lon},
        })
    return {
        "destination": selected,
        "route": {
            "distance_m": round(route["distance"]),
            "duration_s": round(route["duration"]),
            "steps": steps,
            "geometry": route["geometry"],
        },
        "attribution": "Route and place data © OpenStreetMap contributors",
    }
