"""Mark graph edges as 'travelled' by matching them against travelled polylines
(e.g. read from the Wandrer overlay).

Uses a simple grid hash of densified travelled points so the lookup is O(1) per
edge instead of scanning every travelled point.
"""
from __future__ import annotations

import networkx as nx

from .geo import densify, haversine_m

# Grid cell size in degrees latitude (~20 m). An edge counts as travelled when
# its midpoint lies within ~one cell of a travelled point.
_CELL_DEG = 0.00018


def _cell(lat: float, lng: float) -> tuple[int, int]:
    return (round(lat / _CELL_DEG), round(lng / _CELL_DEG))


def mark_travelled(
    g: nx.Graph,
    travelled: list[list[tuple[float, float]]],
    threshold_m: float = 18.0,
) -> int:
    """Set ``travelled=True`` on edges near a travelled polyline.

    Returns the number of edges marked travelled.
    """
    if not travelled:
        return 0

    # Bucket densified travelled points into grid cells.
    cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for line in travelled:
        for pt in densify([(p[0], p[1]) for p in line], step_m=8.0):
            cells.setdefault(_cell(*pt), []).append(pt)

    marked = 0
    for u, v, data in g.edges(data=True):
        au = g.nodes[u]["xy"]
        av = g.nodes[v]["xy"]
        mid = ((au[0] + av[0]) / 2, (au[1] + av[1]) / 2)
        ci, cj = _cell(*mid)
        hit = False
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for pt in cells.get((ci + di, cj + dj), ()):  # noqa: B007
                    if haversine_m(mid, pt) <= threshold_m:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                break
        if hit:
            data["travelled"] = True
            marked += 1
    return marked
