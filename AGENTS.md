# Agent Guidelines for `wandrer-run-planner`

Welcome, Agent! This repository implements an intelligent route planning system that generates running loops designed to **maximize coverage of untravelled paths** (Wandrer's unique red segments) within a user-specified distance target.

---

## 1. System Purpose & Core Architecture

`wandrer-run-planner` combines browser DOM telemetry with a local graph optimization engine:
- **FastAPI Backend (`backend/`)**: High-performance Python backend that queries OpenStreetMap via the Overpass API, builds a walkable `networkx` graph, marks travelled edges, and solves a budget-constrained arc-routing optimization problem.
- **Browser Userscript (`userscript/`)**: A Tampermonkey/Violentmonkey script that extracts live vector tile geometry directly from Mapbox GL maps on `wandrer.earth` and Strava's Route Builder, then relays data to the local backend.
- **Network Interface**: Communicates locally over `http://127.0.0.1:8000` (IPv4 loopback).

---

## 2. Architectural Boundaries & Component Map

- **`backend/app/planner.py`**:
  - Unified orchestration layer powering both the REST API endpoint (`POST /plan`) and the command-line interface (`cli.py`).
- **`backend/app/osm.py`**:
  - Queries the Overpass API (`fetch_overpass`) with a dynamically computed bounding radius (`_radius_for_target`) and transforms raw OSM ways into a walkable `networkx` graph (`build_graph`).
- **`backend/app/travelled.py`**:
  - Evaluates graph edge coverage. Applies **exact OSM way ID matching** first (`mark_travelled_by_osm_id`), falling back to geometric polyline Hausdorff matching (`mark_travelled`) only when OSM IDs are absent.
- **`backend/app/optimize.py`**:
  - Stochastic, budget-constrained arc-routing optimizer (`plan_route`). Constructs closed loops near the target distance while maximizing untravelled road distance and minimizing repeats.
- **`backend/app/export.py`**:
  - Formats output paths into standard GPX (`to_gpx` generating `<trk>` and `<rte>` tags) and waypoint simplifications for Strava's route builder.
- **`backend/app/main.py`**:
  - Lightweight FastAPI web service with CORS locked to `strava.com` and `wandrer.earth`.
- **`userscript/wandrer-run-planner.user.js`**:
  - Standalone userscript interacting with Mapbox GL via `unsafeWindow` (`querySourceFeatures`). Automates route generation and GPX downloads.

---

## 3. Non-Negotiable Domain Invariants & Guardrails

1. **OSM Way ID Matching Priority**:
   - Exact OSM way ID matching (`mark_travelled_by_osm_id`) is a core correctness invariant. Geometric polyline proximity matching is strictly a secondary fallback. Never invert this order.
2. **Userscript Version Control**:
   - **Never manually bump `@version`** in `userscript/wandrer-run-planner.user.js`. Versioning is handled automatically by Release Please via explicit `x-release-please-start-version` and `x-release-please-end-version` comment markers.
3. **Loopback Address Invariant**:
   - The userscript and API bindings must target IPv4 `http://127.0.0.1:8000`, not `localhost` (to eliminate Windows/Linux IPv6 `::1` connection refusals).
4. **Type Strictness**:
   - All backend code must use modern type annotations (`from __future__ import annotations`), validated by `mypy` and structured with Pydantic v2 schemas (`models.py`).

---

## 4. Operational Verification & Testing Protocol

All backend verification is executed from `backend/`:

```powershell
# 1. Linting (Ruff):
ruff check app tests

# 2. Type checking (Mypy):
mypy

# 3. Unit tests (37 tests across API, OSM, optimizer, export):
.\.venv\Scripts\python.exe -m pytest -p no:logfire --basetemp=.pytest_temp

# 4. Clean up test temp files:
if (Test-Path .pytest_temp) { Remove-Item -Recurse -Force .pytest_temp }
```

### Operational Commands
- **Run FastAPI server:** `uvicorn app.main:app --reload --port 8000` (or `.\run.ps1` from `backend/`).
- **Run CLI route generation:** `python -m app.cli --lat 49.83 --lng 10.88 --km 6 --out run.gpx`.

---

## 5. State Persistence, Secret Hygiene & Hardware Protection

- **Overpass Query Caching**: Spatial queries calculate bounded search radii to prevent abusive Overpass queries and conserve host memory.
- **Zero-Secret Architecture**: Public route-planning utility; no user credentials or persistent cloud secrets are used.

---

## 6. Git Delivery & Agent Self-Audit Checklist

Before concluding work in this repository:
- [ ] Backend code passes `ruff check app tests`.
- [ ] All unit tests pass (`pytest -p no:logfire`).
- [ ] Release Please version markers in `userscript/wandrer-run-planner.user.js` are preserved untouched.
- [ ] Commit message conforms to Conventional Commits format (`feat(...)`, `fix(...)`).
- [ ] Automated semantic releases and changelogs are managed via Release Please (`release-please-config.json`).
