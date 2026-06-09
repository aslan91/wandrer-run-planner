# Wandrer Run Planner

Plan running routes that **maximize coverage of untravelled paths** (the red
segments in the [Wandrer](https://wandrer.earth/) overlay) within a target
distance, while reusing already‑run (green) paths and repeating segments only
when necessary.

It is built around the workflow you already use: the Strava **route builder**
with the *Wandrer Map Overlay* extension active.

```
Strava route builder (+ Wandrer overlay)
        │  userscript: pick start on map, read travelled tiles
        ▼
Local Python backend  ──Overpass──▶ OSM path network
        │  arc-routing optimizer (maximize untravelled, minimize repeats)
        ▼
route + GPX + waypoints  ──▶  drawn / created back in Strava
```

## Why this design

Wandrer has already connected to your Strava and computed, per road/path
segment, whether you have travelled it. We **reuse that result** instead of
re-deriving it from raw Strava activities. The Wandrer overlay is a vector
source already loaded into Strava's Mapbox GL map, so the userscript reads its
features straight off the **live map** (`querySourceFeatures`) and passes the
travelled geometry to the backend — no tile refetching or MVT decoding needed.
The backend is source‑agnostic (it just needs OSM edges + travelled polylines),
so a Strava-activity-derived provider can be swapped in later if needed.

## Components

| Path | What |
|------|------|
| `backend/` | FastAPI service + optimizer + Overpass client + GPX export |
| `backend/app/cli.py` | Run the full pipeline from the command line (no browser needed) |
| `userscript/wandrer-run-planner.user.js` | Tampermonkey script: in‑Strava UI |

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

Install [Tampermonkey](https://www.tampermonkey.net/), then add
`userscript/wandrer-run-planner.user.js`. Open the Strava route builder; a
**Wandrer Run Planner** panel appears.

### One-time: confirm the overlay is detected

The userscript reads the Wandrer overlay directly from the live map. To confirm
it finds your overlay:

1. Open the Strava route builder with the Wandrer overlay enabled.
2. In the panel, click **Detect overlay**.
3. The status line reports the matched source, how many segments in view are
   travelled, and the available feature property keys.
4. If travelled count is 0 but you know you've run there, open the browser
   console and check which property marks travelled, then add its name to
   `WANDRER.TRAVELLED_KEYS` at the top of the userscript. If no source is
   found, adjust `WANDRER.SOURCE_MATCH` (console logs the available source ids).

Until a source is detected, the planner treats **all** paths as untravelled,
which still produces a valid (just not Wandrer-aware) route.

> Note: `querySourceFeatures` only sees tiles currently loaded in the map view,
> so keep the planning area within the visible map (zoom to roughly the run
> area before planning).

## Status

- [x] Overpass fetch + walkable graph build
- [x] Randomized budget-constrained optimizer (max untravelled, min repeats)
- [x] GPX export + route simplification to Strava waypoints
- [x] FastAPI `/plan` endpoint (CORS for strava.com)
- [x] CLI for browser-free testing
- [x] Userscript: panel, pick-start, plan, draw route
- [x] Live Wandrer overlay read via `querySourceFeatures` + auto-detect
- [ ] "Create route in Strava" via builder save endpoint

This is a private project. Not affiliated with Strava or Wandrer.
