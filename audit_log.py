"""Rotating JSON-lines audit log for security-relevant UI actions (logs/audit.log)."""

from __future__ import annotations

import json
import logging
import time as time_module
from collections.abc import Mapping
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from app_paths import runtime_root

LOGS_DIR = runtime_root() / "logs"
AUDIT_LOG_PATH = LOGS_DIR / "audit.log"

_audit_logger_configured = False


def _logger() -> logging.Logger:
    global _audit_logger_configured
    log = logging.getLogger("sophos_central_gui.audit")
    if _audit_logger_configured:
        return log
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.INFO)
    log.propagate = False
    fh = RotatingFileHandler(
        AUDIT_LOG_PATH,
        maxBytes=2_000_000,
        backupCount=10,
        encoding="utf-8",
    )
    fmt = logging.Formatter(
        "%(asctime)sZ %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    fmt.converter = time_module.gmtime
    fh.setFormatter(fmt)
    log.addHandler(fh)
    _audit_logger_configured = True
    return log


def client_ip(request: Any) -> str | None:
    if request is None:
        return None
    try:
        c = request.client
        return str(c.host) if c and c.host else None
    except Exception:
        return None


def audit_event(
    *,
    action: str,
    outcome: str = "success",
    actor_user_id: str | None = None,
    actor_username: str | None = None,
    detail: Mapping[str, Any] | None = None,
    request: Any = None,
) -> None:
    """Append one JSON audit record (no secrets or password material)."""
    rec: dict[str, Any] = {"action": action, "outcome": outcome}
    if actor_user_id is not None:
        rec["actor_user_id"] = actor_user_id
    if actor_username is not None:
        rec["actor_username"] = actor_username
    ip = client_ip(request)
    if ip:
        rec["client_ip"] = ip
    if detail:
        for k, v in detail.items():
            if v is not None:
                rec[k] = v
    _logger().info(json.dumps(rec, default=str, ensure_ascii=False))


def mask_oauth_client_id(client_id: str) -> str:
    """Short non-reversible fingerprint for audit (not a secret)."""
    s = (client_id or "").strip()
    if len(s) <= 8:
        return "***"
    return f"{s[:4]}…{s[-4:]}"
