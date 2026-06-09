"""Fetch the walkable path network from the OpenStreetMap Overpass API and build
a routing graph."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import networkx as nx
import requests

from .geo import haversine_m
from .log import get_logger

log = get_logger()

# On-disk cache of raw Overpass responses. OSM road geometry changes slowly, so
# re-planning the same area should not hammer (slow, flaky) public Overpass
# servers again. Travelled state is supplied separately by the userscript, so
# caching the road network here is safe.
_CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache" / "overpass"
_CACHE_TTL_S = 7 * 24 * 3600  # a week

# Public Overpass endpoints with free, global, no-key coverage, per the official
# wiki list (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
# private.coffee (formerly kumi.systems) advertises no rate limit, so it leads;
# overpass-api.de is the high-capacity fallback (often 504s under load). The
# other historical mirrors are unusable here: maps.mail.ru is suspended (403),
# overpass.osm.ch is Switzerland-only, openstreetmap.fr 403s. Results are cached
# on disk anyway, so a slow first fetch only happens once per area.
OVERPASS_URLS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
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


def _cache_path(query: str) -> Path:
    key = hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]
    return _CACHE_DIR / f"{key}.json"


def _read_cache(path: Path) -> dict | None:
    try:
        if not path.exists():
            return None
        if time.time() - path.stat().st_mtime > _CACHE_TTL_S:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_cache(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    except OSError as exc:
        log.info("overpass cache write failed: %s", exc)


def fetch_overpass(lat: float, lng: float, radius_m: float, timeout: int = 25) -> dict:
    """Query Overpass for highways around a point. Returns raw JSON.

    Results are cached on disk (keyed by the exact query) so repeated planning
    in the same area is instant and avoids the slow/flaky public servers. Tries
    each public endpoint with a short per-request timeout so a stuck mirror
    fails fast and we move on, instead of blocking until the userscript gives up.

    Uses ``out geom;`` instead of the ``(._;>;); out;`` recursion: it returns
    each way's geometry inline (and keeps the node-id refs for connectivity),
    which is far cheaper for the server and avoids the timeouts the recursive
    union triggers under load.
    """
    query = f"""
    [out:json][timeout:{timeout}];
    way[highway]
       [highway!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway)$"]
       (around:{int(radius_m)},{lat},{lng});
    out geom;
    """

    cache_file = _cache_path(query)
    cached = _read_cache(cache_file)
    if cached is not None:
        log.info("overpass cache hit: %d elements", len(cached.get("elements", [])))
        return cached

    last_error: Exception | None = None
    for attempt in range(3):
        for url in OVERPASS_URLS:
            try:
                log.info("overpass try %d: %s", attempt + 1, url)
                resp = requests.post(
                    url,
                    data={"data": query},
                    headers=_HEADERS,
                    # (connect, read) timeouts: bail on a stalled mirror quickly
                    # so we fail over to the next one instead of hanging.
                    timeout=(10, timeout + 5),
                )
                if resp.status_code in (429, 502, 503, 504):
                    last_error = requests.HTTPError(f"{resp.status_code} from {url}")
                    log.info("overpass %s busy (%d), trying next", url, resp.status_code)
                    continue
                resp.raise_for_status()
                js = resp.json()
                log.info("overpass ok: %d elements", len(js.get("elements", [])))
                _write_cache(cache_file, js)
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
            # `out geom;` embeds each node's coordinates inline (aligned with the
            # way's node-id refs); harvest them so we don't need a separate node
            # list. Falls back gracefully to any `node` elements above.
            geom = el.get("geometry")
            node_ids = el.get("nodes")
            if geom and node_ids and len(geom) == len(node_ids):
                for nid, pt in zip(node_ids, geom):
                    if pt is not None:
                        coords[nid] = (pt["lat"], pt["lon"])

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
