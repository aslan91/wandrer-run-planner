"""FastAPI service the userscript talks to."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import PlanRequest, PlanResponse
from .planner import plan

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
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface upstream errors to the client
        raise HTTPException(status_code=502, detail=f"Planning failed: {exc}") from exc
