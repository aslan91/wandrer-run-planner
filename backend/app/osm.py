"""Fetch the walkable path network from the OpenStreetMap Overpass API and build
a routing graph."""
from __future__ import annotations

import time

import networkx as nx
import requests

from .geo import haversine_m
from .log import get_logger

log = get_logger()

# Public Overpass endpoints, tried in order (they are frequently overloaded).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]

# Overpass rejects requests without a descriptive User-Agent (HTTP 406).
_HEADERS = {
    "User-Agent": "wandrer-run-planner/0.1 (personal project; https://github.com/aslan91)",
}

# Highway values that are reasonable to run on. Motorways/trunks are excluded.
_RUNNABLE = {
    "footway",
    "path",
    "pedestrian",
    "track",
    "steps",
    "living_street",
    "residential",
    "unclassified",
    "service",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "cycleway",
    "bridleway",
    "road",
}


def fetch_overpass(lat: float, lng: float, radius_m: float, timeout: int = 60) -> dict:
    """Query Overpass for highways around a point. Returns raw JSON.

    Tries each public endpoint with retries, since they are often overloaded
    (HTTP 429/504) or temporarily unreachable.
    """
    query = f"""
    [out:json][timeout:{timeout}];
    way[highway]
       [highway!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway)$"]
       (around:{int(radius_m)},{lat},{lng});
    (._;>;);
    out;
    """
    last_error: Exception | None = None
    for attempt in range(3):
        for url in OVERPASS_URLS:
            try:
                log.info("overpass try %d: %s", attempt + 1, url)
                resp = requests.post(
                    url, data={"data": query}, headers=_HEADERS, timeout=timeout + 10
                )
                if resp.status_code in (429, 502, 503, 504):
                    last_error = requests.HTTPError(f"{resp.status_code} from {url}")
                    log.info("overpass %s busy (%d), trying next", url, resp.status_code)
                    continue
                resp.raise_for_status()
                js = resp.json()
                log.info("overpass ok: %d elements", len(js.get("elements", [])))
                return js
            except requests.RequestException as exc:
                last_error = exc
                log.info("overpass %s failed: %s", url, exc)
                continue
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"All Overpass endpoints failed: {last_error}")


def build_graph(overpass_json: dict) -> nx.Graph:
    """Build an undirected graph: nodes = OSM nodes, edges = path segments.

    Each edge carries ``length`` (metres), ``travelled`` (bool, default False),
    and ``osm_ids`` (set of OSM way ids that the segment belongs to).
    Each node carries ``xy`` = (lat, lng).
    """
    coords: dict[int, tuple[float, float]] = {}
    ways: list[dict] = []
    for el in overpass_json.get("elements", []):
        if el["type"] == "node":
            coords[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)

    g = nx.Graph()
    for way in ways:
        tags = way.get("tags", {})
        if tags.get("highway") not in _RUNNABLE:
            continue
        if tags.get("foot") == "no" or tags.get("access") in {"private", "no"}:
            continue
        way_id = way.get("id")
        node_ids = way.get("nodes", [])
        for a, b in zip(node_ids[:-1], node_ids[1:]):
            if a not in coords or b not in coords:
                continue
            ca, cb = coords[a], coords[b]
            length = haversine_m(ca, cb)
            if length <= 0:
                continue
            if not g.has_node(a):
                g.add_node(a, xy=ca)
            if not g.has_node(b):
                g.add_node(b, xy=cb)
            if g.has_edge(a, b):
                # Keep the shorter edge if a duplicate way segment appears, and
                # remember every way id sharing this segment.
                if length < g[a][b]["length"]:
                    g[a][b]["length"] = length
                if way_id is not None:
                    g[a][b]["osm_ids"].add(way_id)
            else:
                osm_ids = {way_id} if way_id is not None else set()
                g.add_edge(a, b, length=length, travelled=False, osm_ids=osm_ids)
    return g


def nearest_node(g: nx.Graph, lat: float, lng: float) -> int:
    """Return the graph node closest to the given point."""
    target = (lat, lng)
    best_node = None
    best_d = float("inf")
    for node, data in g.nodes(data=True):
        d = haversine_m(data["xy"], target)
        if d < best_d:
            best_d = d
            best_node = node
    if best_node is None:
        raise ValueError("Graph has no nodes near the start point.")
    return best_node
