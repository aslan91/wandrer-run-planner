"""Tests for planner orchestration helpers."""
from __future__ import annotations

from app.planner import _radius_for_target


def test_radius_has_floor() -> None:
    assert _radius_for_target(0.5) == 600.0


def test_radius_has_ceiling() -> None:
    assert _radius_for_target(100.0) == 4000.0


def test_radius_scales_with_target() -> None:
    assert _radius_for_target(6.0) == 6.0 * 1000.0 * 0.35
