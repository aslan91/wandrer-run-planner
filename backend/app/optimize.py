"""Budget-constrained route optimizer.

Goal: from a start node, build a closed walk whose total length is within
``[target - tol, target + tol]`` that maximizes the length of *untravelled*
edges covered, while reusing edges as little as possible.

This is a prize-collecting rural-postman / orienteering problem (NP-hard), so we
use a randomized greedy heuristic with many restarts and keep the best walk.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

import networkx as nx


@dataclass
class Route:
    nodes: list[int]
    coords: list[tuple[float, float]]
    distance_m: float
    new_m: float
    repeat_m: float
    score: float


def _one_walk(
    g: nx.Graph,
    start: int,
    target_m: float,
    tol_m: float,
    home_dist: dict[int, float],
    rng: random.Random,
    max_steps: int = 4000,
) -> Route | None:
    cur = start
    nodes = [start]
    used: set[frozenset] = set()
    covered: set[frozenset] = set()
    dist = 0.0
    new = 0.0
    repeat = 0.0

    for _ in range(max_steps):
        if dist >= target_m - tol_m:
            break

        candidates = []
        for nb in g.neighbors(cur):
            if nb not in home_dist:
                continue
            edge = g[cur][nb]
            elen = edge["length"]
            # Must still be able to return home within budget.
            if dist + elen + home_dist[nb] > target_m + tol_m:
                continue
            eid = frozenset((cur, nb))
            weight = 1.0
            if not edge["travelled"] and eid not in covered:
                weight *= 6.0  # strongly prefer new ground
            if eid in used:
                weight *= 0.12  # avoid repeats
            if len(nodes) >= 2 and nb == nodes[-2]:
                weight *= 0.05  # avoid immediate backtracking
            candidates.append((nb, elen, eid, edge["travelled"], weight))

        if not candidates:
            break

        total = sum(c[4] for c in candidates)
        r = rng.random() * total
        acc = 0.0
        chosen = candidates[-1]
        for c in candidates:
            acc += c[4]
            if r <= acc:
                chosen = c
                break

        nb, elen, eid, travelled, _w = chosen
        dist += elen
        if eid in used or eid in covered:
            repeat += elen
        if not travelled and eid not in covered:
            new += elen
            covered.add(eid)
        used.add(eid)
        nodes.append(nb)
        cur = nb

    # Close the loop back to the start via the shortest path.
    if cur != start:
        try:
            home = nx.shortest_path(g, cur, start, weight="length")
        except nx.NetworkXNoPath:
            return None
        for a, b in zip(home[:-1], home[1:]):
            edge = g[a][b]
            elen = edge["length"]
            eid = frozenset((a, b))
            dist += elen
            if eid in used or eid in covered:
                repeat += elen
            if not edge["travelled"] and eid not in covered:
                new += elen
                covered.add(eid)
            used.add(eid)
            nodes.append(b)

    coords = [g.nodes[n]["xy"] for n in nodes]
    # Penalize being outside the target window so in-window routes always win.
    penalty = 1000.0 * max(0.0, abs(dist - target_m) - tol_m)
    score = new - penalty
    return Route(nodes, coords, dist, new, repeat, score)


def plan_route(
    g: nx.Graph,
    start: int,
    target_m: float,
    tol_m: float,
    attempts: int = 250,
    seed: int | None = None,
) -> Route | None:
    """Run many randomized walks and return the best one."""
    rng = random.Random(seed)
    home_dist = nx.single_source_dijkstra_path_length(g, start, weight="length")

    best: Route | None = None
    for _ in range(attempts):
        route = _one_walk(g, start, target_m, tol_m, home_dist, rng)
        if route is None:
            continue
        if best is None or route.score > best.score:
            best = route
    return best
