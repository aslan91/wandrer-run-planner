"""Tiny logging helper so the console shows live progress while planning.

Uvicorn configures its own loggers but not the root logger, so we attach our
own stdout handler to a dedicated "wandrer" logger (and disable propagation to
avoid duplicate lines).
"""
from __future__ import annotations

import logging
import sys

_CONFIGURED = False


def get_logger(name: str = "wandrer") -> logging.Logger:
    global _CONFIGURED
    logger = logging.getLogger(name)
    if not _CONFIGURED:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s [WRP] %(message)s", "%H:%M:%S")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        _CONFIGURED = True
    return logger
