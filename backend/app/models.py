"""Request/response models for the planning API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class LatLng(BaseModel):
    lat: float
    lng: float


class PlanRequest(BaseModel):
    start: LatLng
    target_km: float = Field(6.0, gt=0.2, le=100)
    tolerance_km: float = Field(1.0, ge=0.0, le=20)
    # Travelled (already-run) paths as polylines of [lat, lng] pairs, e.g. read
    # from the Wandrer overlay tiles by the userscript. Optional: if omitted,
    # every path is treated as untravelled.
    travelled: list[list[tuple[float, float]]] = Field(default_factory=list)
    # Exact travelled match: OSM way ids that Wandrer marks as travelled. When
    # present these mark edges precisely (no geometric fuzz); polylines remain a
    # fallback for any segment without an id match.
    travelled_osm_ids: list[int] = Field(default_factory=list)
    # Number of randomized optimizer attempts (more = better but slower).
    attempts: int = Field(250, ge=1, le=5000)
    seed: int | None = None


class PlanResponse(BaseModel):
    distance_km: float
    new_km: float
    repeat_km: float
    coverage_pct: float
    # Full route geometry as [lat, lng] pairs (for GPX / drawing).
    coordinates: list[tuple[float, float]]
    # Simplified waypoints to feed the Strava route builder (it re-snaps to roads).
    waypoints: list[tuple[float, float]]
    gpx: str
