"""Small key-free walking navigation adapter.

The prototype deliberately keeps routing on the laptop so the phone only has
to send its current location and a destination.  Nominatim supplies one
destination geocode and the OpenStreetMap foot router supplies turn steps.
Both services are public and rate limited; this is intended for demos, not a
production navigation service.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from typing import Any

import aiohttp


class NavigationError(RuntimeError):
    """Raised when a destination cannot be geocoded or routed."""


@dataclass(frozen=True)
class RouteStep:
    instruction: str
    distance_m: float
    distance_to_maneuver_m: float
    latitude: float
    longitude: float

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutePlan:
    destination: str
    distance_m: float
    duration_s: float
    steps: tuple[RouteStep, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "destination": self.destination,
            "distance_m": round(self.distance_m, 1),
            "duration_s": round(self.duration_s, 1),
            "steps": [step.as_dict() for step in self.steps],
        }


def _format_distance(distance_m: float) -> str:
    if distance_m < 100:
        rounded = max(5, int(round(distance_m / 5.0) * 5))
        return f"{rounded} meters"
    if distance_m < 1000:
        rounded = max(10, int(round(distance_m / 10.0) * 10))
        return f"{rounded} meters"
    return f"{distance_m / 1000:.1f} kilometers"


def _road_name(step: dict[str, Any]) -> str:
    name = str(step.get("name") or "").strip()
    return f" onto {name}" if name else ""


def build_instruction(
    step: dict[str, Any],
    destination: str,
    distance_to_maneuver_m: float,
) -> str:
    """Turn one OSRM step into a short instruction suitable for speech."""
    maneuver = step.get("maneuver") or {}
    maneuver_type = str(maneuver.get("type") or "continue").lower()
    modifier = str(maneuver.get("modifier") or "").replace("-", " ")
    road = _road_name(step)
    distance = _format_distance(distance_to_maneuver_m)

    if maneuver_type == "depart":
        return f"Start walking{road}."
    if maneuver_type == "arrive":
        return f"You have arrived at {destination}."
    if maneuver_type == "roundabout":
        exit_number = maneuver.get("exit")
        exit_text = f" exit {int(exit_number)}" if exit_number else ""
        return f"In {distance}, enter the roundabout and take{exit_text}{road}."
    if maneuver_type in {"turn", "end of road", "fork", "merge", "on ramp", "off ramp"}:
        action = f"turn {modifier}" if modifier else "continue"
        return f"In {distance}, {action}{road}."
    if maneuver_type in {"continue", "new name", "notification"}:
        return f"In {distance}, continue{road}."
    return f"In {distance}, continue{road}."


def parse_route_response(payload: dict[str, Any], destination: str) -> RoutePlan:
    """Parse the small subset of an OSRM response used by the phone client."""
    if payload.get("code") != "Ok":
        raise NavigationError(str(payload.get("message") or "The walking route was unavailable."))

    routes = payload.get("routes")
    if not isinstance(routes, list) or not routes:
        raise NavigationError("The walking route was unavailable.")
    route = routes[0]
    if not isinstance(route, dict):
        raise NavigationError("The walking route response was invalid.")
    legs = route.get("legs")
    if not isinstance(legs, list) or not legs or not isinstance(legs[0], dict):
        raise NavigationError("The walking route had no turn steps.")

    steps: list[RouteStep] = []
    previous_segment_distance = 0.0
    for raw_step in legs[0].get("steps", []):
        if not isinstance(raw_step, dict):
            continue
        maneuver = raw_step.get("maneuver") or {}
        location = maneuver.get("location")
        if (
            not isinstance(location, list)
            or len(location) < 2
            or not isinstance(location[0], (int, float))
            or not isinstance(location[1], (int, float))
        ):
            continue
        segment_distance = float(raw_step.get("distance") or 0.0)
        steps.append(
            RouteStep(
                instruction=build_instruction(
                    raw_step, destination, previous_segment_distance
                ),
                distance_m=round(max(0.0, segment_distance), 1),
                distance_to_maneuver_m=round(max(0.0, previous_segment_distance), 1),
                latitude=float(location[1]),
                longitude=float(location[0]),
            )
        )
        previous_segment_distance = segment_distance

    if not steps:
        raise NavigationError("The walking route had no usable turn steps.")

    return RoutePlan(
        destination=destination,
        distance_m=float(route.get("distance") or 0.0),
        duration_s=float(route.get("duration") or 0.0),
        steps=tuple(steps),
    )


class NavigationService:
    """Geocode once, then request a walking route from the public OSM router."""

    def __init__(
        self,
        geocoder_url: str = "https://nominatim.openstreetmap.org/search",
        router_url: str = "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
        timeout_seconds: float = 15.0,
        user_agent: str = "assistive-hardware-prototype/0.1",
    ) -> None:
        self.geocoder_url = geocoder_url
        self.router_url = router_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self.headers = {"User-Agent": user_agent, "Accept": "application/json"}
        self.session: aiohttp.ClientSession | None = None

    async def _get_json(self, url: str, params: dict[str, str]) -> dict[str, Any] | list[Any]:
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=self.timeout, headers=self.headers)
        try:
            async with self.session.get(url, params=params) as response:
                if response.status >= 400:
                    detail = (await response.text())[:200]
                    raise NavigationError(f"Routing service HTTP {response.status}: {detail}")
                body = await response.json()
        except asyncio.TimeoutError as exc:
            raise NavigationError("The routing service timed out.") from exc
        except aiohttp.ClientError as exc:
            raise NavigationError("Cannot reach the routing service.") from exc
        if not isinstance(body, (dict, list)):
            raise NavigationError("The routing service returned invalid JSON.")
        return body

    async def plan(
        self, latitude: float, longitude: float, destination: str
    ) -> RoutePlan:
        target = destination.strip()
        if not target:
            raise NavigationError("A destination is required.")

        # A viewbox makes short spoken destinations such as "student center"
        # resolve near the person instead of to a similarly named place in a
        # different city. If speech includes a campus brand, retry the local
        # place name without that brand when the first query has no result.
        viewbox = f"{longitude - 0.1},{latitude + 0.1},{longitude + 0.1},{latitude - 0.1}"
        queries = [target]
        lowered_target = target.lower()
        if "georgia tech" in lowered_target:
            without_brand = target.replace("Georgia Tech", "").replace("georgia tech", "").strip(" ,")
            if without_brand and without_brand not in queries:
                queries.append(without_brand)

        geocoded: list[Any] = []
        for query in queries:
            candidate = await self._get_json(
                self.geocoder_url,
                {
                    "q": query,
                    "format": "jsonv2",
                    "limit": "1",
                    "addressdetails": "1",
                    "viewbox": viewbox,
                },
            )
            if isinstance(candidate, list) and candidate:
                geocoded = candidate
                break

        if not geocoded or not isinstance(geocoded[0], dict):
            raise NavigationError(f"I could not find {target}.")
        result = geocoded[0]
        try:
            destination_latitude = float(result["lat"])
            destination_longitude = float(result["lon"])
        except (KeyError, TypeError, ValueError) as exc:
            raise NavigationError("The destination geocode was invalid.") from exc

        payload = await self._get_json(
            f"{self.router_url}/{longitude},{latitude};{destination_longitude},{destination_latitude}",
            {
                "steps": "true",
                "overview": "false",
                "alternatives": "false",
                "geometries": "geojson",
            },
        )
        if not isinstance(payload, dict):
            raise NavigationError("The routing service returned an invalid route.")
        # Keep the user's wording for speech; full geocoder display names are
        # often long postal addresses and are distracting on arrival.
        return parse_route_response(payload, target)

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()
            self.session = None
