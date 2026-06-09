"""Tests for geometry helpers."""
from __future__ import annotations

import math

from app.geo import densify, haversine_m, m_per_deg_lon


def test_haversine_zero_distance() -> None:
    p = (49.83, 10.88)
    assert haversine_m(p, p) == 0.0


def test_haversine_known_distance() -> None:
    # One degree of latitude is ~111.32 km.
    d = haversine_m((0.0, 0.0), (1.0, 0.0))
    assert math.isclose(d, 111_195, rel_tol=1e-3)


def test_haversine_symmetric() -> None:
    a, b = (49.0, 10.0), (49.1, 10.2)
    assert math.isclose(haversine_m(a, b), haversine_m(b, a))


def test_m_per_deg_lon_shrinks_with_latitude() -> None:
    assert m_per_deg_lon(0.0) > m_per_deg_lon(60.0)
    assert math.isclose(m_per_deg_lon(0.0), 111_320.0)
    assert math.isclose(m_per_deg_lon(60.0), 111_320.0 * 0.5, rel_tol=1e-6)


def test_densify_inserts_intermediate_points() -> None:
    line = [(0.0, 0.0), (0.0, 0.01)]  # ~1.1 km apart
    dense = densify(line, step_m=100.0)
    assert dense[0] == line[0]
    assert dense[-1] == line[-1]
    assert len(dense) > 2
    # Consecutive points must now be <= step apart.
    for a, b in zip(dense[:-1], dense[1:], strict=True):
        assert haversine_m(a, b) <= 100.0 + 1e-6


def test_densify_short_line_unchanged() -> None:
    assert densify([(1.0, 2.0)]) == [(1.0, 2.0)]
    assert densify([]) == []
