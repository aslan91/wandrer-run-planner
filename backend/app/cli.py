"""Command-line entry point so the pipeline is usable without the browser.

Example:
    python -m app.cli --lat 49.83 --lng 10.88 --km 6 --tol 1 --out run.gpx
"""
from __future__ import annotations

import argparse
import json
import sys

from .models import LatLng, PlanRequest
from .planner import plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Plan a Wandrer-aware running route.")
    parser.add_argument("--lat", type=float, required=True, help="Start latitude")
    parser.add_argument("--lng", type=float, required=True, help="Start longitude")
    parser.add_argument("--km", type=float, default=6.0, help="Target distance (km)")
    parser.add_argument("--tol", type=float, default=1.0, help="Distance tolerance (km)")
    parser.add_argument("--attempts", type=int, default=250, help="Optimizer restarts")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument(
        "--travelled",
        type=str,
        default=None,
        help="Path to a JSON file: list of polylines [[[lat,lng],...],...]",
    )
    parser.add_argument("--out", type=str, default="run.gpx", help="Output GPX path")
    args = parser.parse_args(argv)

    travelled: list[list[tuple[float, float]]] = []
    if args.travelled:
        with open(args.travelled, encoding="utf-8") as fh:
            travelled = json.load(fh)

    req = PlanRequest(
        start=LatLng(lat=args.lat, lng=args.lng),
        target_km=args.km,
        tolerance_km=args.tol,
        travelled=travelled,
        attempts=args.attempts,
        seed=args.seed,
    )

    res = plan(req)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(res.gpx)

    print(
        f"distance={res.distance_km} km  new={res.new_km} km  "
        f"repeat={res.repeat_km} km  coverage={res.coverage_pct}%  "
        f"waypoints={len(res.waypoints)}  -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
