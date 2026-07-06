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


def test_plan_route_covers_dead_end_spur() -> None:
    # A grid that is already fully travelled, plus a single untravelled spur
    # hanging off an interior junction and ending in a dead end. The only way to
    # cover it is an out-and-back, which the optimizer should still do.
    g = _grid_graph()
    for _, _, d in g.edges(data=True):
        d["travelled"] = True
    junction = 14  # interior node (row 2, col 2)
    spur_tip = 100  # fresh node id outside the grid
    deg = 100.0 / 111_320.0
    g.add_node(spur_tip, xy=(2 * deg, 3.5 * deg))
    g.add_edge(junction, spur_tip, length=120.0, travelled=False, osm_ids=set())

    route = plan_route(g, 0, 1000.0, 300.0, attempts=300, seed=5)
    assert route is not None
    # The dead-end spur tip must appear on the route, and it must be reached and
    # left via the same junction (out-and-back).
    assert spur_tip in route.nodes
    assert route.new_m > 0


def test_plan_route_does_not_reward_excluded() -> None:
    # Option 1 has new ground, Option 2 is excluded. The optimizer should choose Option 1.
    g = nx.Graph()
    deg = 100.0 / 111_320.0
    g.add_node(0, xy=(0.0, 0.0))
    g.add_node(1, xy=(0.0, deg))
    g.add_node(2, xy=(deg, 0.0))

    # 0-1 is untravelled
    g.add_edge(0, 1, length=100.0, travelled=False, excluded=False, osm_ids=set())
    # 0-2 is excluded
    g.add_edge(0, 2, length=100.0, travelled=False, excluded=True, osm_ids=set())

    route = plan_route(g, start=0, target_m=200.0, tol_m=10.0, attempts=100, seed=1)
    assert route is not None
    assert 2 not in route.nodes
    assert 1 in route.nodes


