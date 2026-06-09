"""Tests for the FastAPI app: health check and request validation."""
from __future__ import annotations

from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health() -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_plan_rejects_missing_start() -> None:
    resp = client.post("/plan", json={"target_km": 6})
    assert resp.status_code == 422


def test_plan_rejects_out_of_range_target() -> None:
    body = {"start": {"lat": 49.83, "lng": 10.88}, "target_km": 999}
    resp = client.post("/plan", json=body)
    assert resp.status_code == 422
