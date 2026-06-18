"""Tests for the OSM graph builder and travelled-marking."""
from __future__ import annotations

import networkx as nx
from app.osm import build_graph, nearest_node
from app.travelled import mark_travelled, mark_travelled_by_osm_id


def _overpass_way(
    way_id: int,
    nodes: list[tuple[int, float, float]],
    highway: str = "residential",
) -> dict:
    """Build a single-way Overpass `out geom;` response."""
    return {
        "elements": [
            {
                "type": "way",
                "id": way_id,
                "tags": {"highway": highway},
                "nodes": [nid for nid, _, _ in nodes],
                "geometry": [{"lat": lat, "lon": lon} for _, lat, lon in nodes],
            }
        ]
    }


def test_build_graph_creates_edges() -> None:
    data = _overpass_way(100, [(1, 0.0, 0.0), (2, 0.0, 0.001), (3, 0.0, 0.002)])
    g = build_graph(data)
    assert g.number_of_nodes() == 3
    assert g.number_of_edges() == 2
    assert g.has_edge(1, 2) and g.has_edge(2, 3)
    assert g[1][2]["length"] > 0
    assert g[1][2]["travelled"] is False
    assert 100 in g[1][2]["osm_ids"]


def test_build_graph_skips_non_runnable_highways() -> None:
    data = _overpass_way(1, [(1, 0.0, 0.0), (2, 0.0, 0.001)], highway="motorway")
    g = build_graph(data)
    assert g.number_of_edges() == 0


def test_build_graph_skips_private_access() -> None:
    data = _overpass_way(1, [(1, 0.0, 0.0), (2, 0.0, 0.001)])
    data["elements"][0]["tags"]["access"] = "private"
    g = build_graph(data)
    assert g.number_of_edges() == 0


def test_build_graph_marks_excluded_service() -> None:
    # Parking aisles render colour-less on Wandrer (not scored): kept as a
    # connector but flagged excluded so the optimizer won't reward covering it.
    data = _overpass_way(1, [(1, 0.0, 0.0), (2, 0.0, 0.001)], highway="service")
    data["elements"][0]["tags"]["service"] = "parking_aisle"
    g = build_graph(data)
    assert g.number_of_edges() == 1
    assert g[1][2]["excluded"] is True


def test_build_graph_normal_way_not_excluded() -> None:
    data = _overpass_way(1, [(1, 0.0, 0.0), (2, 0.0, 0.001)])
    g = build_graph(data)
    assert g[1][2]["excluded"] is False


def test_nearest_node_finds_closest() -> None:
    data = _overpass_way(1, [(1, 0.0, 0.0), (2, 0.0, 0.01), (3, 0.0, 0.02)])
    g = build_graph(data)
    assert nearest_node(g, 0.0, 0.0199) == 3


def test_mark_travelled_by_osm_id_exact() -> None:
    data = _overpass_way(42, [(1, 0.0, 0.0), (2, 0.0, 0.001)])
    g = build_graph(data)
    assert mark_travelled_by_osm_id(g, {42}) == 1
    assert g[1][2]["travelled"] is True
    # No-op for unknown ids.
    assert mark_travelled_by_osm_id(g, {999}) == 0


def test_mark_travelled_by_geometry() -> None:
    g = nx.Graph()
    g.add_node(1, xy=(49.0, 10.0))
    g.add_node(2, xy=(49.0, 10.001))
    g.add_edge(1, 2, length=70.0, travelled=False, osm_ids=set())
    # A polyline running right along the edge midpoint marks it travelled.
    line = [(49.0, 9.9995), (49.0, 10.0015)]
    assert mark_travelled(g, [line]) == 1
    assert g[1][2]["travelled"] is True


def test_mark_travelled_ignores_distant_polyline() -> None:
    g = nx.Graph()
    g.add_node(1, xy=(49.0, 10.0))
    g.add_node(2, xy=(49.0, 10.001))
    g.add_edge(1, 2, length=70.0, travelled=False, osm_ids=set())
    far = [(50.0, 11.0), (50.0, 11.001)]
    assert mark_travelled(g, [far]) == 0
    assert g[1][2]["travelled"] is False
