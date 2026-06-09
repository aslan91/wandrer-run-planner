"""Route export + simplification helpers."""
from __future__ import annotations

import gpxpy
import gpxpy.gpx

from .geo import haversine_m


def to_gpx(coords: list[tuple[float, float]], name: str = "Wandrer Run") -> str:
    """Serialize a [lat, lng] route to a GPX string.

    Emits a single ``<trk>`` plus top-level metadata. We deliberately do NOT
    also emit a ``<rte>`` with the same geometry: Strava's route upload counts
    both elements, which doubles the reported distance.
    """
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "wandrer-run-planner"
    gpx.name = name
    gpx.description = "Planned to maximize untravelled (Wandrer) paths."

    track = gpxpy.gpx.GPXTrack(name=name)
    track.type = "running"  # type: ignore[assignment]  # gpxpy stubs type this as None
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)
    for lat, lng in coords:
        segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lng))

    return gpx.to_xml()


def _perp_dist_m(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    """Approximate perpendicular distance (m) of point ``p`` from segment ``a``-``b``."""
    if a == b:
        return haversine_m(p, a)
    # Work in a local planar approximation using distances.
    da = haversine_m(p, a)
    db = haversine_m(p, b)
    ab = haversine_m(a, b)
    # Heron's formula for triangle area, then height = 2*area/base.
    s = (da + db + ab) / 2
    area_sq = max(0.0, s * (s - da) * (s - db) * (s - ab))
    area = area_sq**0.5
    return 2 * area / ab if ab > 0 else da


def simplify(
    coords: list[tuple[float, float]], tolerance_m: float = 25.0, max_points: int = 100
) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker simplification, capped at ``max_points`` waypoints.

    Strava's builder re-snaps waypoints to roads, so a sparse set is enough.
    """
    if len(coords) <= 2:
        return list(coords)

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        max_d = -1.0
        idx = lo
        for i in range(lo + 1, hi):
            d = _perp_dist_m(coords[i], coords[lo], coords[hi])
            if d > max_d:
                max_d = d
                idx = i
        if max_d > tolerance_m:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))

    pts = [c for c, k in zip(coords, keep, strict=True) if k]
    if len(pts) > max_points:
        step = len(pts) / max_points
        pts = [pts[int(i * step)] for i in range(max_points)]
        pts[-1] = coords[-1]
    return pts
