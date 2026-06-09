# Wandrer Run Planner

[![CI](https://github.com/aslan91/wandrer-run-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/aslan91/wandrer-run-planner/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Plan running routes that **maximize coverage of untravelled paths** (the red
segments on [Wandrer](https://wandrer.earth/)) within a target distance, while
reusing already‑run (green) paths and repeating segments only when necessary.

The userscript runs on **two** sites:

- **wandrer.earth** — its **Big Map** is the *primary, canonical* source of your
  travelled data. Pick a start, plan, and download a GPX. (Recommended.)
- **strava.com** — the **route builder** with the *Wandrer Map Overlay*
  extension active. Everything above, **plus** an optional "create the route
  directly in Strava" step (Wandrer has no route builder).

```
wandrer.earth Big Map        OR        Strava route builder (+ Wandrer overlay)
   │  read native travelled                │  read overlay travelled
   ▼                                        ▼
      Local Python backend  ──Overpass──▶ OSM path network
              │  arc-routing optimizer (maximize untravelled, minimize repeats)
              ▼
      route + GPX (+ optional draw-in-Strava)
```

## Why this design

Wandrer has already connected to your Strava/Garmin/RideWithGPS and computed,
per road/path segment, whether you have travelled it. We **reuse that result**
instead of re-deriving it from raw activities. That travelled data is a vector
source on a Mapbox GL map, so the userscript reads its features straight off the
**live map** (`querySourceFeatures`) and passes the travelled geometry to the
backend — no tile refetching or MVT decoding needed.

The most reliable place to read it is **wandrer.earth's own Big Map**, where the
data is native (no dependency on the overlay extension being injected
elsewhere), tagged with exact OSM way ids (`osm_id_str`) for precise matching.
Strava is supported too because it adds one thing Wandrer lacks — a **route
builder** — so you can optionally draw the planned route straight into Strava.
The backend is source‑agnostic (it just needs OSM edges + travelled polylines),
so either site feeds the same pipeline.

## Components

| Path | What |
|------|------|
| `backend/` | FastAPI service + optimizer + Overpass client + GPX export |
| `backend/app/cli.py` | Run the full pipeline from the command line (no browser needed) |
| `userscript/wandrer-run-planner.user.js` | Tampermonkey script: in‑page UI on wandrer.earth's Big Map and Strava's route builder |

## Quick start (backend)

```powershell
cd D:\WS\priv\wandrer-run-planner\backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Test the pipeline end-to-end (no Wandrer data yet -> every path counts as new):
python -m app.cli --lat 49.83 --lng 10.88 --km 6 --out ..\run.gpx

# Run the API the userscript talks to:
uvicorn app.main:app --reload --port 8000
```

> On Windows, run via the venv to avoid a global Python without FastAPI:
> `.\run.ps1` (wraps `.\.venv\Scripts\python.exe -m uvicorn ...`). Use
> `.\run.ps1 -Port 8080` or `.\run.ps1 -NoReload` as needed.

## Userscript

Install a userscript manager ([Tampermonkey](https://www.tampermonkey.net/) or
[Violentmonkey](https://violentmonkey.github.io/)), then install the script
directly from the raw URL (the manager will offer an install prompt and keep it
up to date automatically):

<https://raw.githubusercontent.com/aslan91/wandrer-run-planner/main/userscript/wandrer-run-planner.user.js>

Alternatively, open `userscript/wandrer-run-planner.user.js` and paste its
contents into a new userscript. The backend must be running locally (see
*Quick start* above) for planning to work. Open either **wandrer.earth → Big
Map** or the **Strava route builder**; a **Wandrer Run Planner** panel appears
(drag it by its title bar to reposition; the position is remembered). The panel
title shows which site you're on.

### One-time: confirm travelled data is detected

The userscript reads travelled segments directly from the live map. To confirm
it finds your data:

1. Open **wandrer.earth → Big Map**, or the Strava route builder with the
   Wandrer overlay enabled.
2. In the panel, click **Detect overlay**.
3. The status line reports the matched source, how many segments in view are
   travelled, the number of OSM ids found, and the available property keys.
4. If travelled count is 0 but you know you've run there, zoom/pan so the area
   is in view and retry (only loaded tiles are readable). On Strava, if a source
   still isn't found you can tune `ADAPTERS.strava.overlay` at the top of the
   userscript (the console logs the available source ids). On wandrer.earth the
   travelled sources are fixed in `ADAPTERS.wandrer.native`.

Until a source is detected, the planner treats **all** paths as untravelled,
which still produces a valid (just not Wandrer-aware) route.

> Note: `querySourceFeatures` only sees tiles currently loaded in the map view,
> so keep the planning area within the visible map (zoom to roughly the run
> area before planning).

### Using a planned route

After **Plan route**, use the result via:

1. **Download GPX (recommended, both sites).** One click writes a GPX with both
   a `<trk>` and a `<rte>` plus metadata, named
   `wandrer-run-<date>-<km>km.gpx`. This is the reliable, exact path: load it
   straight onto a watch (Garmin, COROS, …) or import it into a mapping app.
   Strava subscribers can import it via **Dashboard → Routes → Upload a Route**.
   Because browsers don't let a script choose a file in another site's upload
   dialog (and Strava has no public route-creation API), the file pick itself is
   the one manual step — everything up to it is automated.
2. **Create in Strava (experimental, Strava only).** Hidden under *Advanced*,
   and shown only on strava.com. Replays the route into Strava's *manual mode*
   by synthesizing map clicks. It needs no file import but depends on Strava's
   current DOM/UI, so it can break when Strava changes their builder. Prefer the
   GPX path; use this only if you want the route drawn directly in the open
   builder.

## Status

- [x] Overpass fetch + walkable graph build
- [x] Randomized budget-constrained optimizer (max untravelled, min repeats)
- [x] GPX export (`<trk>` + metadata) + waypoint simplification
- [x] FastAPI `/plan` endpoint (CORS for strava.com + wandrer.earth)
- [x] CLI for browser-free testing
- [x] Userscript: panel, pick-start (map or paste lat,lng), plan, draw route
- [x] Live travelled read via `querySourceFeatures` (per-site adapter)
- [x] **Native wandrer.earth Big Map support** (primary source; exact OSM ids)
- [x] **Primary export: one-click GPX** (watch / mapping app / Strava route upload)
- [x] Experimental "Create in Strava" via manual-mode point replay (Strava only)

## License

Released under the [MIT License](LICENSE).

This is a personal hobby project, not affiliated with, endorsed by, or
connected to Strava or Wandrer. Use it at your own risk and in accordance with
their respective terms of service.
