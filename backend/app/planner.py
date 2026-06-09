"""High-level orchestration shared by the API and the CLI."""
from __future__ import annotations

from . import export, osm, travelled
from .models import PlanRequest, PlanResponse
from .optimize import plan_route


def _radius_for_target(target_km: float) -> float:
    """Search radius (m) around the start. Enough to reach out and loop back."""
    return max(800.0, min(8000.0, target_km * 1000.0 * 0.6))


def plan(req: PlanRequest) -> PlanResponse:
    radius = _radius_for_target(req.target_km)
    data = osm.fetch_overpass(req.start.lat, req.start.lng, radius)
    g = osm.build_graph(data)
    if g.number_of_edges() == 0:
        raise ValueError("No runnable paths found near the start point.")

    # Prefer exact OSM-id matching (Wandrer tags each segment with its OSM way
    # id); fall back to geometric matching for anything not covered by ids.
    travelled.mark_travelled_by_osm_id(g, set(req.travelled_osm_ids))
    travelled.mark_travelled(g, req.travelled)

    start_node = osm.nearest_node(g, req.start.lat, req.start.lng)
    target_m = req.target_km * 1000.0
    tol_m = req.tolerance_km * 1000.0

    route = plan_route(
        g, start_node, target_m, tol_m, attempts=req.attempts, seed=req.seed
    )
    if route is None:
        raise ValueError("Could not build a loop of the requested length here.")

    coverage = 100.0 * route.new_m / route.distance_m if route.distance_m else 0.0
    gpx = export.to_gpx(route.coords)
    waypoints = export.simplify(route.coords)

    return PlanResponse(
        distance_km=round(route.distance_m / 1000.0, 3),
        new_km=round(route.new_m / 1000.0, 3),
        repeat_km=round(route.repeat_m / 1000.0, 3),
        coverage_pct=round(coverage, 1),
        coordinates=route.coords,
        waypoints=waypoints,
        gpx=gpx,
    )
