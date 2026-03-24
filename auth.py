"""Session-backed UI authentication and password hashing."""

from __future__ import annotations

import os
import secrets
import time
from typing import Literal

from app_paths import runtime_root
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import HTTPException, Request

SESSION_USER_ID_KEY = "user_id"
SESSION_LAST_ACTIVITY_KEY = "last_activity_at"

SESSION_SECRET_PATH = runtime_root() / "sophos_session_secret"
SESSION_SECRET_ENV = "_".join(("SOPHOS", "CENTRAL", "GUI", "SESSION", "SECRET"))

_password_hasher = PasswordHasher(
    time_cost=3,
    memory_cost=64 * 1024,
    parallelism=2,
    hash_len=32,
    salt_len=16,
)


def get_session_secret() -> str:
    env = os.environ.get(SESSION_SECRET_ENV)
    if env and str(env).strip():
        return str(env).strip()
    if SESSION_SECRET_PATH.exists():
        return SESSION_SECRET_PATH.read_text(encoding="utf-8").strip()
    raw = secrets.token_hex(32)
    SESSION_SECRET_PATH.write_text(raw, encoding="utf-8")
    try:
        os.chmod(SESSION_SECRET_PATH, 0o600)
    except (NotImplementedError, OSError, AttributeError):
        pass
    return raw


def hash_password(plain: str) -> str:
    return _password_hasher.hash(plain)


def verify_password(plain: str, stored_hash: str | None) -> bool:
    if not stored_hash or not str(stored_hash).strip():
        return False
    try:
        _password_hasher.verify(stored_hash, plain)
        if _password_hasher.check_needs_rehash(stored_hash):
            return True
        return True
    except VerifyMismatchError:
        return False


def validate_new_password(pw: str) -> None:
    if len(pw) < 10:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 10 characters.",
        )
    if len(pw) > 256:
        raise HTTPException(status_code=400, detail="Password is too long.")


def session_user_id(request: Request) -> str | None:
    sid = request.session.get(SESSION_USER_ID_KEY)
    if sid is None:
        return None
    s = str(sid).strip()
    return s or None


def touch_session_activity(request: Request) -> None:
    request.session[SESSION_LAST_ACTIVITY_KEY] = time.time()


def evaluate_session_idle(
    request: Request, idle_timeout_seconds: float
) -> tuple[Literal["ok", "expired"], str | None]:
    """
    When idle_timeout_seconds <= 0, idle is disabled.
    On expiry the session is cleared; returns ("expired", former_user_id) for audit logging.
    """
    if idle_timeout_seconds <= 0:
        return "ok", None
    last = request.session.get(SESSION_LAST_ACTIVITY_KEY)
    if last is None:
        return "ok", None
    if time.time() - float(last) > idle_timeout_seconds:
        expired_uid = session_user_id(request)
        request.session.clear()
        return "expired", expired_uid
    return "ok", None


def require_authenticated_user_id(request: Request) -> str:
    uid = session_user_id(request)
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


def require_admin(request: Request) -> str:
    uid = require_authenticated_user_id(request)
    from credential_store import get_app_user_by_id, get_secrets_db

    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, uid)
    if not row or row["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return uid
