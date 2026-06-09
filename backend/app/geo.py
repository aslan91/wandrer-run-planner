"""Small geometry helpers (no numpy/shapely dependency)."""
from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_000.0

# A degree of latitude is ~111_320 m everywhere; longitude shrinks with latitude.
M_PER_DEG_LAT = 111_320.0


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between (lat, lng) points ``a`` and ``b``."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def m_per_deg_lon(lat_deg: float) -> float:
    """Metres per degree of longitude at the given latitude."""
    return M_PER_DEG_LAT * math.cos(math.radians(lat_deg))


def densify(
    polyline: list[tuple[float, float]], step_m: float = 10.0
) -> list[tuple[float, float]]:
    """Return ``polyline`` with extra points so consecutive points are <= ``step_m`` apart."""
    if len(polyline) < 2:
        return list(polyline)
    out: list[tuple[float, float]] = [polyline[0]]
    for a, b in zip(polyline[:-1], polyline[1:], strict=True):
        seg = haversine_m(a, b)
        n = max(1, math.ceil(seg / step_m))
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out
