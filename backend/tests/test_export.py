"""Tests for GPX export and route simplification."""
from __future__ import annotations

import xml.etree.ElementTree as ET

from app.export import simplify, to_gpx


def test_to_gpx_roundtrip() -> None:
    coords = [(49.83, 10.88), (49.84, 10.89), (49.85, 10.90)]
    xml = to_gpx(coords, name="Test Run")
    root = ET.fromstring(xml)
    # GPX namespace-agnostic search for track points.
    pts = [el for el in root.iter() if el.tag.endswith("trkpt")]
    assert len(pts) == len(coords)
    assert pts[0].attrib["lat"] == "49.83"
    assert pts[0].attrib["lon"] == "10.88"


def test_simplify_keeps_endpoints() -> None:
    coords = [(0.0, 0.0), (0.0, 0.001), (0.0, 0.002)]
    out = simplify(coords, tolerance_m=25.0)
    assert out[0] == coords[0]
    assert out[-1] == coords[-1]


def test_simplify_drops_collinear_points() -> None:
    # A straight line: the middle point is redundant within tolerance.
    coords = [(0.0, 0.0), (0.0, 0.0005), (0.0, 0.001)]
    out = simplify(coords, tolerance_m=25.0)
    assert out == [(0.0, 0.0), (0.0, 0.001)]


def test_simplify_respects_max_points() -> None:
    # A zig-zag where every vertex matters, but cap the output.
    coords = []
    for i in range(500):
        coords.append((0.0001 * i, 0.0 if i % 2 == 0 else 0.0005))
    out = simplify(coords, tolerance_m=1.0, max_points=50)
    assert len(out) <= 50
    assert out[0] == coords[0]
    assert out[-1] == coords[-1]


def test_simplify_short_input_unchanged() -> None:
    coords = [(1.0, 2.0), (3.0, 4.0)]
    assert simplify(coords) == coords
