"""FastAPI service the userscript talks to."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .log import get_logger
from .models import PlanRequest, PlanResponse
from .planner import plan

log = get_logger()

app = FastAPI(title="Wandrer Run Planner", version="0.1.0")

# The userscript runs on strava.com and calls this local server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://www.strava.com"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/plan", response_model=PlanResponse)
def plan_endpoint(req: PlanRequest) -> PlanResponse:
    try:
        return plan(req)
    except ValueError as exc:
        # Caller asked for something we can't satisfy (e.g. no paths, no loop).
        log.info("plan rejected: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        # Upstream dependency (Overpass) is unavailable — transient, retryable.
        log.warning("plan upstream failure: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - last resort: surface as a 500
        log.exception("plan failed")
        raise HTTPException(status_code=500, detail=f"Planning failed: {exc}") from exc
