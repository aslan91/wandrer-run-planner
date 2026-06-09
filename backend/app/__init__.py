"""Wandrer Run Planner backend package."""
from __future__ import annotations

# Use the operating-system certificate store for TLS so requests work behind
# corporate proxies that perform TLS inspection (the OS trust store holds the
# corporate root CA). No-op if truststore is unavailable.
try:  # pragma: no cover - environment dependent
    import truststore

    truststore.inject_into_ssl()
except Exception:  # noqa: BLE001
    pass
