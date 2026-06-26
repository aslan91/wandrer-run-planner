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

from .log import get_logger

log = get_logger()


@dataclass
class Route:
    nodes: list[int]
    coords: list[tuple[float, float]]
    distance_m: float
    new_m: float
    repeat_m: float
    score: float


def _new_ground_spur_entries(g: nx.Graph) -> dict[int, set[int]]:
    """Find dead-end spurs that contain untravelled ground.

    A spur is a chain of degree-2 nodes ending in a dead end (degree-1 node).
    The only way to cover an untravelled spur is an out-and-back from the
    junction where it branches off, so we record that junction and the spur's
    first node. The walker uses this to dive into the spur whenever it passes
    the junction, instead of skipping it (which would force a wasteful repeat
    trip later just to reach the dead end).

    Returns ``{junction_node: {first_spur_node, ...}}``.
    """
    deg = dict(g.degree())
    entries: dict[int, set[int]] = {}
    for leaf in [n for n in g.nodes if deg[n] == 1]:
        prev: int | None = None
        cur = leaf
        spur_edges: list[tuple[int, int]] = []
        junction: int | None = None
        # Walk inward through the degree-2 chain until we reach a junction.
        while True:
            nbrs = [x for x in g.neighbors(cur) if x != prev]
            if not nbrs:
                break
            nxt = nbrs[0]
            spur_edges.append((cur, nxt))
            if deg[nxt] != 2:
                junction = nxt
                break
            prev, cur = cur, nxt
        if junction is None:
            continue
        has_new = any(
            not g[a][b]["travelled"] and not g[a][b].get("excluded")
            for a, b in spur_edges
        )
        if has_new:
            first = spur_edges[-1][0]  # spur node adjacent to the junction
            entries.setdefault(junction, set()).add(first)
    return entries


def _one_walk(
    g: nx.Graph,
    start: int,
    target_m: float,
    tol_m: float,
    home_dist: dict[int, float],
    spur_entries: dict[int, set[int]],
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
            new_ground = not edge["travelled"] and not edge.get("excluded")
            weight = 1.0
            if new_ground and eid not in covered:
                weight *= 6.0  # strongly prefer new ground
            if cur in spur_entries and nb in spur_entries[cur] and eid not in used:
                # Diving into an untravelled dead-end spur while we're at its
                # junction: cover it now (out-and-back) so we don't have to come
                # all the way back here later just to reach the dead end.
                weight *= 40.0
            if eid in used:
                weight *= 0.12  # avoid repeats
            if len(nodes) >= 2 and nb == nodes[-2]:
                weight *= 0.05  # avoid immediate backtracking
            candidates.append((nb, elen, eid, new_ground, weight))

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

        nb, elen, eid, new_ground, _w = chosen
        dist += elen
        if eid in used or eid in covered:
            repeat += elen
        if new_ground and eid not in covered:
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
        for a, b in zip(home[:-1], home[1:], strict=True):
            edge = g[a][b]
            elen = edge["length"]
            eid = frozenset((a, b))
            dist += elen
            if eid in used or eid in covered:
                repeat += elen
            if not edge["travelled"] and not edge.get("excluded") and eid not in covered:
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
    spur_entries = _new_ground_spur_entries(g)

    best: Route | None = None
    log_every = max(1, attempts // 10)
    for i in range(attempts):
        route = _one_walk(g, start, target_m, tol_m, home_dist, spur_entries, rng)
        if route is None:
            continue
        if best is None or route.score > best.score:
            best = route
        if (i + 1) % log_every == 0:
            if best is not None:
                log.info(
                    "  attempt %d/%d — best: %.2fkm, new %.2fkm",
                    i + 1, attempts, best.distance_m / 1000.0, best.new_m / 1000.0,
                )
            else:
                log.info("  attempt %d/%d — no valid loop yet", i + 1, attempts)
    return best
