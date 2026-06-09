"""High-level orchestration shared by the API and the CLI."""
from __future__ import annotations

import time

from . import export, osm, travelled
from .log import get_logger
from .models import PlanRequest, PlanResponse
from .optimize import plan_route

log = get_logger()


def _radius_for_target(target_km: float) -> float:
    """Search radius (m) around the start. Enough to reach out and loop back.

    A closed loop of length L stays geometrically compact (a perfect circle of
    circumference L has radius L/2pi ~= 0.16*L), so a search radius near
    0.35*L gives plenty of room for detours while keeping the Overpass query
    small and fast. Oversized radii make Overpass slow/time out.
    """
    return max(600.0, min(4000.0, target_km * 1000.0 * 0.35))


def plan(req: PlanRequest) -> PlanResponse:
    t0 = time.perf_counter()
    radius = _radius_for_target(req.target_km)
    log.info(
        "plan: start=(%.5f, %.5f) target=%.1fkm tol=%.1fkm radius=%.0fm",
        req.start.lat, req.start.lng, req.target_km, req.tolerance_km, radius,
    )

    log.info("fetching OSM paths from Overpass…")
    data = osm.fetch_overpass(req.start.lat, req.start.lng, radius)
    g = osm.build_graph(data)
    log.info("graph built: %d nodes, %d edges", g.number_of_nodes(), g.number_of_edges())
    if g.number_of_edges() == 0:
        raise ValueError("No runnable paths found near the start point.")

    # Prefer exact OSM-id matching (Wandrer tags each segment with its OSM way
    # id); fall back to geometric matching for anything not covered by ids.
    n_by_id = travelled.mark_travelled_by_osm_id(g, set(req.travelled_osm_ids))
    n_by_geo = travelled.mark_travelled(g, req.travelled)
    n_travelled = sum(1 for _, _, d in g.edges(data=True) if d.get("travelled"))
    log.info(
        "travelled marked: %d edges (%s by osm-id, %s by geometry); "
        "%d osm-ids + %d polylines supplied",
        n_travelled, n_by_id, n_by_geo,
        len(req.travelled_osm_ids), len(req.travelled),
    )

    start_node = osm.nearest_node(g, req.start.lat, req.start.lng)
    target_m = req.target_km * 1000.0
    tol_m = req.tolerance_km * 1000.0

    log.info("optimizing route (%d attempts)…", req.attempts)
    route = plan_route(
        g, start_node, target_m, tol_m, attempts=req.attempts, seed=req.seed
    )
    if route is None:
        raise ValueError("Could not build a loop of the requested length here.")

    coverage = 100.0 * route.new_m / route.distance_m if route.distance_m else 0.0
    gpx = export.to_gpx(route.coords)
    waypoints = export.simplify(route.coords)
    log.info(
        "done in %.1fs: distance=%.2fkm new=%.2fkm repeat=%.2fkm coverage=%.0f%% "
        "waypoints=%d",
        time.perf_counter() - t0,
        route.distance_m / 1000.0, route.new_m / 1000.0, route.repeat_m / 1000.0,
        coverage, len(waypoints),
    )

    return PlanResponse(
        distance_km=round(route.distance_m / 1000.0, 3),
        new_km=round(route.new_m / 1000.0, 3),
        repeat_km=round(route.repeat_m / 1000.0, 3),
        coverage_pct=round(coverage, 1),
        coordinates=route.coords,
        waypoints=waypoints,
        gpx=gpx,
    )
