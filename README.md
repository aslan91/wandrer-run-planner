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
re-deriving it from raw Strava activities. The userscript runs inside your
authenticated Strava session, so it can read the same Wandrer tiles the overlay
draws and pass that "travelled" geometry to the backend. The backend is
source‑agnostic — it just needs OSM edges + a set of travelled polylines — so a
Strava-activity-derived provider can be swapped in later if needed.

The route planning itself is a budget‑constrained **arc‑routing / orienteering**
problem (NP‑hard), solved here with a fast randomized heuristic.

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

## Userscript

Install [Tampermonkey](https://www.tampermonkey.net/), then add
`userscript/wandrer-run-planner.user.js`. Open the Strava route builder; a
**Wandrer Run Planner** panel appears.

### One-time: capture the Wandrer tile endpoint

The Wandrer overlay is a premium feature whose tile URL is not public, so we read
it from your own browser:

1. Open the Strava route builder with the Wandrer overlay enabled.
2. DevTools → **Network** → filter `wandrer` (or `.pbf` / `.mvt`).
3. Copy the request URL template (look for `{z}/{x}/{y}`) and the property name
   that marks a segment as travelled.
4. Paste both into the `WANDRER` config block at the top of the userscript.

Until that is filled in, the planner treats **all** paths as untravelled, which
still produces a valid (just not Wandrer-aware) route.

## Status

- [x] Overpass fetch + walkable graph build
- [x] Randomized budget-constrained optimizer (max untravelled, min repeats)
- [x] GPX export + route simplification to Strava waypoints
- [x] FastAPI `/plan` endpoint (CORS for strava.com)
- [x] CLI for browser-free testing
- [x] Userscript skeleton: panel, pick-start, plan, draw route
- [ ] Live Wandrer tile endpoint wired in (capture from DevTools)
- [ ] "Create route in Strava" via builder save endpoint

This is a private project. Not affiliated with Strava or Wandrer.
