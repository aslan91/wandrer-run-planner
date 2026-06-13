# Copilot Instructions — wandrer-run-planner

Plans running routes that **maximize coverage of untravelled paths** (Wandrer's red segments) within
a target distance. Two parts: a local **FastAPI backend** (the arc-routing optimizer) and a
**Tampermonkey/Violentmonkey userscript** that reads "travelled" geometry off the live Mapbox map on
wandrer.earth's Big Map and Strava's route builder, then calls the backend.

## Commands

All backend work happens in `backend/` (it's the package root; `app/` and `tests/` live there).

- Setup: `pip install -e ".[dev]"` (from `backend/`).
- Run the API: `uvicorn app.main:app --reload --port 8000` (or `.\run.ps1` on Windows, which uses the
  venv; `.\run.ps1 -Port 8080`, `.\run.ps1 -NoReload`).
- Run the full pipeline without a browser: `python -m app.cli --lat 49.83 --lng 10.88 --km 6 --out ..\run.gpx`.
- CI runs three checks (from `backend/`), all must pass:
  - Lint: `ruff check app tests`
  - Types: `mypy`
  - Tests: `pytest`
- Run a single test file/case: `pytest tests/test_optimize.py` or `pytest tests/test_optimize.py::test_name -q`.
- Optional local hooks: `pre-commit install` (from the repo root; runs Ruff via `.pre-commit-config.yaml`).

## Architecture

`backend/app/planner.py:plan()` is the orchestration shared by both the API (`main.py:/plan`) and the
CLI (`cli.py`). The pipeline:

1. `osm.py` — fetch the path network from the **Overpass API** around the start (`fetch_overpass`),
   build a walkable `networkx` graph (`build_graph`), and find the nearest start node. Search radius
   is derived from the target distance (`_radius_for_target`) to keep Overpass queries fast.
2. `travelled.py` — mark graph edges as already-run. **Exact OSM-way-id matching is preferred**
   (`mark_travelled_by_osm_id`, since Wandrer tags each segment with its OSM id); geometric polyline
   matching (`mark_travelled`) is the fallback for segments without an id.
3. `optimize.py:plan_route` — randomized, budget-constrained arc-routing optimizer: build a closed
   loop near `target_km` that maximizes untravelled distance and minimizes repeats (`attempts`/`seed`
   control the search).
4. `export.py` — `to_gpx` (writes `<trk>` + `<rte>` + metadata) and `simplify` (waypoints for Strava's
   route builder, which re-snaps to roads).

`main.py` is a thin FastAPI layer: CORS is locked to `strava.com` + `wandrer.earth`, and exceptions
map to specific HTTP codes (`ValueError`→422 unsatisfiable, `RuntimeError`→503 Overpass down, else 500).

### Userscript (`userscript/wandrer-run-planner.user.js`)

Single self-contained file with a `// ==UserScript==` metadata block (bump `@version` on changes).
Key design points to preserve:
- Reads travelled features off the **live Mapbox GL map** via `querySourceFeatures` — only tiles
  currently in view are readable.
- Must access the map through `unsafeWindow` (the page's real window); the sandbox `window` has no
  `mapboxgl`. The `PAGE` constant encodes this.
- Per-site differences are isolated in the `ADAPTERS` object (`strava` vs `wandrer`); everything else
  is shared. wandrer.earth is the canonical source (native OSM ids, GPX export only); Strava adds the
  experimental "create route via manual-mode click replay".
- Backend URL is `http://127.0.0.1:8000` — uses `127.0.0.1`, not `localhost` (IPv6 `::1` vs uvicorn's
  IPv4 bind). Network calls go through `GM_xmlhttpRequest` (see `@connect` grants).

## Conventions

- Backend targets Python >=3.10, typed throughout (`from __future__ import annotations`), checked by
  mypy. API request/response shapes are pydantic v2 models in `models.py` — extend those, don't pass
  loose dicts.
- Ruff config (line length 100, rule sets E/F/I/B/UP/SIM/C4) and mypy live in `backend/pyproject.toml`.
- Log via `from .log import get_logger` (`log = get_logger()`), `%`-style args.
- Keep the two reading strategies' priority (OSM id first, geometry fallback) — it's a correctness
  property, not a perf tweak.
- PR titles must follow Conventional Commits (enforced by `.github/workflows/pr-title.yml`), matching
  the sibling bot repos. Since Dependabot PRs are squash-merged, the PR title becomes the commit message.
- MIT licensed; this is a personal hobby project not affiliated with Strava or Wandrer.
