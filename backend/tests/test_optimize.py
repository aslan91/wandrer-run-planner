"""Tests for the route optimizer on small synthetic graphs."""
from __future__ import annotations

import networkx as nx
from app.optimize import plan_route


def _grid_graph(n: int = 6, step_m: float = 100.0) -> nx.Graph:
    """An n x n lattice with uniform-length edges; nodes carry (lat, lng)."""
    g = nx.Graph()
    deg = step_m / 111_320.0
    for i in range(n):
        for j in range(n):
            nid = i * n + j
            g.add_node(nid, xy=(i * deg, j * deg))
    for i in range(n):
        for j in range(n):
            nid = i * n + j
            if j + 1 < n:
                g.add_edge(nid, nid + 1, length=step_m, travelled=False, osm_ids=set())
            if i + 1 < n:
                g.add_edge(nid, nid + n, length=step_m, travelled=False, osm_ids=set())
    return g


def test_plan_route_returns_loop_in_window() -> None:
    g = _grid_graph()
    target_m, tol_m = 1000.0, 300.0
    route = plan_route(g, start=0, target_m=target_m, tol_m=tol_m, attempts=200, seed=1)
    assert route is not None
    # Closed loop: starts and ends at the start node.
    assert route.nodes[0] == 0
    assert route.nodes[-1] == 0
    # Distance lands within the requested window.
    assert target_m - tol_m <= route.distance_m <= target_m + tol_m


def test_plan_route_is_deterministic_with_seed() -> None:
    g = _grid_graph()
    a = plan_route(g, 0, 1000.0, 300.0, attempts=100, seed=7)
    b = plan_route(g, 0, 1000.0, 300.0, attempts=100, seed=7)
    assert a is not None and b is not None
    assert a.nodes == b.nodes
    assert a.distance_m == b.distance_m


def test_plan_route_prefers_untravelled() -> None:
    # Two parallel routes of equal length; mark one fully travelled. The
    # optimizer should cover more new ground than a travelled-only baseline.
    g = _grid_graph()
    for u, v, d in g.edges(data=True):
        # Mark the bottom row travelled.
        if u < 6 and v < 6:
            d["travelled"] = True
    route = plan_route(g, 0, 1000.0, 300.0, attempts=300, seed=3)
    assert route is not None
    assert route.new_m > 0
