"""Sophos Central–style web UI backed by sophos_central.db."""

from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlencode, urljoin

import requests
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from auth import (
    SESSION_USER_ID_KEY,
    evaluate_session_idle,
    get_session_secret,
    hash_password,
    require_admin,
    require_authenticated_user_id,
    session_user_id,
    touch_session_activity,
    validate_new_password,
    verify_password,
)
from central.classes import CentralResponse
from central.session import CentralSession
from credential_store import (
    DEFAULT_ADMIN_USERNAME,
    SECRETS_DB_PATH,
    bootstrap_setup_target_user_id,
    count_admins,
    credential_name_for_tenant_client_id,
    delete_app_user,
    delete_credential,
    ensure_default_admin_user,
    get_app_user_by_id,
    get_app_user_by_username,
    get_secrets_db,
    get_credential_id_by_client_id,
    get_stored_credential_secrets,
    get_stored_credential_secrets_by_client_id,
    insert_app_user,
    insert_credential,
    list_app_users,
    count_credentials_by_id_type,
    credentials_interval_summary,
    list_credentials,
    max_last_successful_sync_at,
    needs_initial_admin_password,
    update_app_user_password_hash,
    update_app_user_profile_cols,
    update_app_user_role,
    user_row_public,
    update_credential_name,
    update_credential_sync_interval,
    update_credential_whoami,
    whoami_dict_from_session,
)
from sync_runner import configure_sync_file_logging, get_public_sync_activity, run_credential_sync
from sync_scheduler import start_scheduler_thread

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "sophos_central.db"
TEMPLATES = ROOT / "templates"
STATIC = ROOT / "static"

jinja = Environment(
    loader=FileSystemLoader(str(TEMPLATES)),
    autoescape=select_autoescape(["html", "xml"]),
)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def ensure_app_ui_schema(conn: sqlite3.Connection) -> None:
    """Single-row UI preferences stored in the central database."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_ui_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          fw_new_max_age_hours INTEGER NOT NULL DEFAULT 168,
          fw_updated_max_age_hours INTEGER NOT NULL DEFAULT 48,
          session_idle_timeout_minutes INTEGER NOT NULL DEFAULT 60
        )
        """
    )
    conn.execute("INSERT OR IGNORE INTO app_ui_settings (id) VALUES (1)")
    cols = {row[1] for row in conn.execute("PRAGMA table_info(app_ui_settings)").fetchall()}
    if "session_idle_timeout_minutes" not in cols:
        conn.execute(
            "ALTER TABLE app_ui_settings ADD COLUMN session_idle_timeout_minutes "
            "INTEGER NOT NULL DEFAULT 60"
        )
    conn.commit()


@contextmanager
def get_db_with_sec():
    """Central DB with secrets DB attached as ``sec`` (for credential-based tenant labels)."""
    with get_db() as conn:
        conn.execute("ATTACH DATABASE ? AS sec", (str(SECRETS_DB_PATH.resolve()),))
        try:
            yield conn
        finally:
            conn.execute("DETACH DATABASE sec")


def _sql_tenant_label_expr(table_alias: str) -> str:
    """When tenants.name equals tenants.id, prefer matching credential name from sec."""
    if not str(table_alias).isalnum():
        raise ValueError("invalid SQL alias")
    a = table_alias
    return (
        "(CASE WHEN "
        + a
        + ".name = "
        + a
        + ".id THEN COALESCE("
        "(SELECT c.name FROM sec.central_credentials c "
        "WHERE TRIM(c.client_id) = TRIM("
        + a
        + ".id) "
        "OR (json_valid(c.whoami_json) "
        "AND TRIM(json_extract(c.whoami_json, '$.id')) = TRIM("
        + a
        + ".id)) "
        "ORDER BY c.name COLLATE NOCASE LIMIT 1), "
        + a
        + ".name) "
        "ELSE "
        + a
        + ".name END)"
    )


_TENANT_ID_COL_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$")


def _sql_cred_name_for_tenant_id_col(tenant_id_column: str) -> str:
    """Scalar subquery: credential name when client_id or whoami.id matches tenant UUID."""
    if not _TENANT_ID_COL_RE.match(tenant_id_column):
        raise ValueError("invalid tenant id column reference")
    col = tenant_id_column
    return (
        "(SELECT c.name FROM sec.central_credentials c "
        "WHERE TRIM(c.client_id) = TRIM("
        + col
        + ") "
        "OR (json_valid(c.whoami_json) "
        "AND TRIM(json_extract(c.whoami_json, '$.id')) = TRIM("
        + col
        + ")) "
        "ORDER BY c.name COLLATE NOCASE LIMIT 1)"
    )


def _sql_tenant_display_coalesced(tenants_alias: str, tenant_id_column: str) -> str:
    """
    Resolved tenant label for UI: tenants row (if present), else credential name for FK
    tenant_id (tenant-scoped sync often has no tenants row), else raw id, else '—'.
    """
    if not str(tenants_alias).isalnum():
        raise ValueError("invalid SQL alias")
    if not _TENANT_ID_COL_RE.match(tenant_id_column):
        raise ValueError("invalid tenant id column reference")
    tl = _sql_tenant_label_expr(tenants_alias)
    cred = _sql_cred_name_for_tenant_id_col(tenant_id_column)
    return (
        "COALESCE("
        + tl
        + ", "
        + cred
        + ", NULLIF(TRIM("
        + tenant_id_column
        + "), ''), '—')"
    )


def _sql_alerts_tenant_display() -> str:
    return _sql_tenant_display_coalesced("t", "a.tenant_id")


def _sql_alerts_tenant_search_lower() -> str:
    inner = (
        "COALESCE("
        + _sql_tenant_label_expr("t")
        + ", "
        + _sql_cred_name_for_tenant_id_col("a.tenant_id")
        + ", NULLIF(TRIM(a.tenant_id), ''), '')"
    )
    return "LOWER(" + inner + ")"


def row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


def _parse_firewall_group_items_json(raw: str | None) -> list[str]:
    """Return firewall ids listed in a group's ``firewalls_items_json`` array."""
    if raw is None or str(raw).strip() == "":
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for item in data:
        if isinstance(item, dict):
            fid = item.get("id")
            if fid is not None and str(fid).strip():
                out.append(str(fid).strip())
    return out


def _firewall_group_breadcrumb_levels(group_id: str, by_id: dict[str, dict]) -> list[dict[str, str]]:
    """Each level: Central group id and display name, root → leaf; last three levels only (same window as ``/api/firewall-groups``)."""
    levels_rev: list[tuple[str, str]] = []
    cur: str | None = group_id
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        row = by_id.get(cur)
        if not row:
            break
        nm = (row.get("name") or "").strip() or "—"
        levels_rev.append((cur, nm))
        parent = row.get("parent_group_id")
        cur = str(parent).strip() if parent is not None and str(parent).strip() else None
    levels = list(reversed(levels_rev))
    if len(levels) > 3:
        levels = levels[-3:]
    return [{"id": gid, "name": nm} for gid, nm in levels]


def _firewall_central_group_breadcrumbs_map(conn: sqlite3.Connection) -> dict[tuple[str, str], list[dict[str, object]]]:
    """(tenant_id, firewall_id) → ``{levels: [{id, name}, ...]}`` entries for groups whose ``firewalls_items_json`` lists that id."""
    cur = conn.execute(
        """
        SELECT id, tenant_id, name, parent_group_id, firewalls_items_json
        FROM firewall_groups
        """
    )
    group_rows = [row_to_dict(r) for r in cur.fetchall()]
    by_id = {str(g["id"]): g for g in group_rows if g.get("id") is not None and str(g["id"]).strip()}

    raw_map: dict[tuple[str, str], list[list[dict[str, str]]]] = defaultdict(list)
    for g in group_rows:
        gid = g.get("id")
        tid = g.get("tenant_id")
        if gid is None or tid is None:
            continue
        gid_s = str(gid).strip()
        tid_s = str(tid).strip()
        if not gid_s or not tid_s:
            continue
        levels = _firewall_group_breadcrumb_levels(gid_s, by_id)
        if not levels:
            leaf = (g.get("name") or "").strip() or "—"
            levels = [{"id": gid_s, "name": leaf}]
        for fw_id in _parse_firewall_group_items_json(g.get("firewalls_items_json")):
            raw_map[(tid_s, fw_id)].append(levels[:])

    out: dict[tuple[str, str], list[dict[str, object]]] = {}
    for key, lists in raw_map.items():
        seen_sig: set[tuple[str, ...]] = set()
        uniq: list[dict[str, object]] = []
        for lev in lists:
            sig = tuple(x["id"] for x in lev)
            if sig in seen_sig:
                continue
            seen_sig.add(sig)
            uniq.append({"levels": lev})
        out[key] = uniq
    return out


NOMINATIM_USER_AGENT = "SophosCentralGUI/0.1 (local dashboard; geocoding via Nominatim)"


def _nominatim_search(q: str, limit: int = 8) -> list[dict]:
    """Forward geocode via OpenStreetMap Nominatim (usage policy: low volume, identify app)."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    limit = max(1, min(int(limit), 10))
    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": q, "format": "json", "limit": str(limit)},
            headers={"User-Agent": NOMINATIM_USER_AGENT},
            timeout=15,
        )
    except requests.RequestException:
        return []
    if resp.status_code != 200:
        return []
    raw = resp.text
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        lat_s = item.get("lat")
        lon_s = item.get("lon")
        if lat_s is None or lon_s is None:
            continue
        try:
            lat = float(lat_s)
            lon = float(lon_s)
        except (TypeError, ValueError):
            continue
        disp = item.get("display_name")
        out.append(
            {
                "display_name": disp if isinstance(disp, str) else "",
                "lat": lat,
                "lon": lon,
            }
        )
    return out


def _json_string_list(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for x in data:
        if x is None:
            continue
        s = str(x).strip()
        if s:
            out.append(s)
    return out


def _upgrade_versions_from_json(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(v) for v in parsed if v is not None and str(v).strip() != ""]


def _tenant_name_for_id(conn: sqlite3.Connection, tenant_id: str | None) -> str | None:
    if not tenant_id:
        return None
    tid_s = str(tenant_id).strip()
    if not tid_s:
        return None
    row = conn.execute(
        "SELECT name, id FROM tenants WHERE id = ?", (tid_s,)
    ).fetchone()
    with get_secrets_db() as sconn:
        cred_label = credential_name_for_tenant_client_id(sconn, tid_s)
    if not row:
        return cred_label or tid_s
    name, tid = row["name"], row["id"]
    if name != tid:
        return name
    return cred_label or name


def _firewall_hostname_name(
    conn: sqlite3.Connection, managed_agent_json: str | None
) -> tuple[str | None, str | None]:
    if not managed_agent_json:
        return None, None
    try:
        parsed = json.loads(managed_agent_json)
    except json.JSONDecodeError:
        return None, None
    agent_id = parsed if isinstance(parsed, str) else None
    if not agent_id:
        return None, None
    row = conn.execute(
        "SELECT hostname, name FROM firewalls WHERE id = ?", (agent_id,)
    ).fetchone()
    if not row:
        return None, None
    return row["hostname"], row["name"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_sync_file_logging()
    if DB_PATH.exists():
        with get_db() as conn:
            ensure_app_ui_schema(conn)
    start_scheduler_thread()
    yield


app = FastAPI(title="Sophos Central GUI", version="0.1.0", lifespan=lifespan)

_cached_session_idle_minutes: int | None = None


def invalidate_session_idle_timeout_cache() -> None:
    global _cached_session_idle_minutes
    _cached_session_idle_minutes = None


def _session_idle_timeout_seconds() -> float:
    """0 means idle timeout disabled (cookie max_age still applies)."""
    global _cached_session_idle_minutes
    if _cached_session_idle_minutes is None:
        if not DB_PATH.exists():
            _cached_session_idle_minutes = 60
        else:
            with get_db() as conn:
                ensure_app_ui_schema(conn)
                row = conn.execute(
                    "SELECT session_idle_timeout_minutes FROM app_ui_settings WHERE id = 1"
                ).fetchone()
            _cached_session_idle_minutes = int(row["session_idle_timeout_minutes"]) if row else 60
    if _cached_session_idle_minutes <= 0:
        return 0.0
    return float(_cached_session_idle_minutes) * 60.0


class ProtectApiMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if not path.startswith("/api/"):
            return await call_next(request)
        public = (
            (method, path) == ("GET", "/api/health")
            or (method, path) == ("GET", "/api/auth/status")
            or (method, path) == ("POST", "/api/auth/login")
            or (method, path) == ("POST", "/api/auth/setup-admin-password")
            or (method, path) == ("POST", "/api/auth/logout")
        )
        if public:
            return await call_next(request)
        uid = session_user_id(request)
        if not uid:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        idle_sec = _session_idle_timeout_seconds()
        if evaluate_session_idle(request, idle_sec) == "expired":
            return JSONResponse(
                {"detail": "Session expired due to inactivity."},
                status_code=401,
            )
        touch_session_activity(request)
        return await call_next(request)


app.add_middleware(ProtectApiMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=get_session_secret(),
    max_age=60 * 60 * 24 * 14,
    same_site="lax",
    https_only=False,
)

app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


def current_user_id_dep(request: Request) -> str:
    return require_authenticated_user_id(request)


def admin_user_id_dep(request: Request) -> str:
    return require_admin(request)


@app.get("/", response_class=HTMLResponse)
def index():
    tpl = jinja.get_template("index.html")
    return HTMLResponse(tpl.render())


@app.get("/api/health")
def health():
    return {"ok": True, "database": DB_PATH.exists()}


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=512)


class SetupAdminPasswordBody(BaseModel):
    password: str = Field(min_length=10, max_length=256)
    password_confirm: str = Field(min_length=10, max_length=256)


class ChangePasswordBody(BaseModel):
    current_password: str = Field(max_length=512)
    new_password: str = Field(min_length=10, max_length=256)
    new_password_confirm: str = Field(min_length=10, max_length=256)


class CreateAppUserBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=10, max_length=256)
    role: str = Field(pattern="^(admin|user)$")
    full_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    mobile: str | None = Field(default=None, max_length=80)


class PatchAppUserBody(BaseModel):
    role: str | None = Field(None, pattern="^(admin|user)$")
    password: str | None = Field(None, min_length=10, max_length=256)
    full_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    mobile: str | None = Field(default=None, max_length=80)


class PatchMyProfileBody(BaseModel):
    """Self-service contact fields only (full name is set by an administrator)."""

    email: str | None = Field(default=None, max_length=320)
    mobile: str | None = Field(default=None, max_length=80)


def _app_user_profile_updates_from_body(
    body: BaseModel, *, keys: frozenset[str] | None = None
) -> dict[str, str | None]:
    raw = body.model_dump(exclude_unset=True)
    want = keys if keys is not None else frozenset({"full_name", "email", "mobile"})
    out: dict[str, str | None] = {}
    for key in want:
        if key not in raw:
            continue
        v = raw[key]
        if v is None:
            out[key] = None
        else:
            t = str(v).strip()
            out[key] = t if t else None
    return out


@app.get("/api/auth/status")
def api_auth_status(request: Request):
    with get_secrets_db() as conn:
        ensure_default_admin_user(conn)
        need_setup = needs_initial_admin_password(conn)
        uid = session_user_id(request)
        if uid:
            idle_sec = _session_idle_timeout_seconds()
            if evaluate_session_idle(request, idle_sec) == "expired":
                uid = None
            else:
                touch_session_activity(request)
                row = get_app_user_by_id(conn, uid)
                if row:
                    # B105 false positive: literal False beside key name containing "password".
                    already_has_password = False
                    return JSONResponse(
                        {
                            "authenticated": True,
                            "needs_admin_password_setup": already_has_password,
                            "user": user_row_public(row),
                        },
                        headers={"Cache-Control": "no-store, must-revalidate"},
                    )
        request.session.pop(SESSION_USER_ID_KEY, None)
    return JSONResponse(
        {
            "authenticated": False,
            "needs_admin_password_setup": need_setup,
            "default_admin_username": DEFAULT_ADMIN_USERNAME if need_setup else None,
            "user": None,
        },
        headers={"Cache-Control": "no-store, must-revalidate"},
    )


@app.post("/api/auth/login")
def api_auth_login(request: Request, body: LoginBody):
    with get_secrets_db() as conn:
        ensure_default_admin_user(conn)
        if needs_initial_admin_password(conn):
            raise HTTPException(
                status_code=400,
                detail="Set the administrator password first (initial setup).",
            )
        row = get_app_user_by_username(conn, body.username)
    if not row or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    request.session[SESSION_USER_ID_KEY] = row["id"]
    touch_session_activity(request)
    with get_secrets_db() as conn:
        row2 = get_app_user_by_id(conn, row["id"])
    return {"ok": True, "user": user_row_public(row2) if row2 else user_row_public(row)}


@app.post("/api/auth/setup-admin-password")
def api_auth_setup_admin_password(request: Request, body: SetupAdminPasswordBody):
    if body.password != body.password_confirm:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    validate_new_password(body.password)
    with get_secrets_db() as conn:
        if not needs_initial_admin_password(conn):
            raise HTTPException(
                status_code=400,
                detail="Initial administrator password is already configured.",
            )
        uid = bootstrap_setup_target_user_id(conn)
        if not uid:
            raise HTTPException(status_code=500, detail="No bootstrap user found.")
        ph = hash_password(body.password)
        if not update_app_user_password_hash(conn, uid, ph):
            raise HTTPException(status_code=500, detail="Could not save password.")
    request.session[SESSION_USER_ID_KEY] = uid
    touch_session_activity(request)
    with get_secrets_db() as conn:
        row2 = get_app_user_by_id(conn, uid)
    return {"ok": True, "user": user_row_public(row2) if row2 else None}


@app.post("/api/auth/activity")
def api_auth_activity():
    """No-op; session idle is refreshed by ProtectApiMiddleware before this runs."""
    return {"ok": True}


@app.post("/api/auth/logout")
def api_auth_logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
def api_auth_me(request: Request, _uid: str = Depends(current_user_id_dep)):
    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, _uid)
    if not row:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Session is no longer valid.")
    return {"user": user_row_public(row)}


@app.patch("/api/auth/profile")
def api_auth_profile_patch(
    request: Request,
    body: PatchMyProfileBody,
    uid: str = Depends(current_user_id_dep),
):
    updates = _app_user_profile_updates_from_body(body, keys=frozenset({"email", "mobile"}))
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    with get_secrets_db() as conn:
        try:
            row = update_app_user_profile_cols(conn, uid, updates)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if row is None:
            request.session.clear()
            raise HTTPException(status_code=401, detail="Session is no longer valid.")
    return {"ok": True, "user": row}


@app.post("/api/auth/change-password")
def api_auth_change_password(
    request: Request,
    body: ChangePasswordBody,
    uid: str = Depends(current_user_id_dep),
):
    if body.new_password != body.new_password_confirm:
        raise HTTPException(status_code=400, detail="New passwords do not match.")
    validate_new_password(body.new_password)
    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, uid)
        if not row:
            request.session.clear()
            raise HTTPException(status_code=401, detail="Session is no longer valid.")
        existing = row["password_hash"]
        if existing:
            if not verify_password(body.current_password, existing):
                raise HTTPException(status_code=400, detail="Current password is incorrect.")
        if not update_app_user_password_hash(conn, uid, hash_password(body.new_password)):
            raise HTTPException(status_code=500, detail="Could not update password.")
    return {"ok": True}


@app.get("/api/settings/users")
def api_settings_users_list(_: str = Depends(current_user_id_dep)):
    with get_secrets_db() as conn:
        return list_app_users(conn)


@app.post("/api/settings/users")
def api_settings_users_create(body: CreateAppUserBody, _: str = Depends(admin_user_id_dep)):
    validate_new_password(body.password)
    uname = body.username.strip()
    with get_secrets_db() as conn:
        if get_app_user_by_username(conn, uname):
            raise HTTPException(status_code=400, detail="That username is already taken.")
        ph = hash_password(body.password)
        return insert_app_user(
            conn,
            username=uname,
            role=body.role,
            password_hash=ph,
            full_name=body.full_name,
            email=body.email,
            mobile=body.mobile,
        )


@app.patch("/api/settings/users/{user_id}")
def api_settings_users_patch(
    user_id: str,
    body: PatchAppUserBody,
    _: str = Depends(admin_user_id_dep),
):
    profile_updates = _app_user_profile_updates_from_body(body)
    if body.role is None and body.password is None and not profile_updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")
        if body.role is not None and body.role != row["role"]:
            if row["role"] == "admin" and body.role == "user" and count_admins(conn) <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot remove the last administrator.",
                )
            out = update_app_user_role(conn, user_id, body.role)
            if out is None:
                raise HTTPException(status_code=404, detail="User not found.")
        if body.password is not None:
            validate_new_password(body.password)
            if not update_app_user_password_hash(conn, user_id, hash_password(body.password)):
                raise HTTPException(status_code=404, detail="User not found.")
        if profile_updates:
            try:
                updated = update_app_user_profile_cols(conn, user_id, profile_updates)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            if updated is None:
                raise HTTPException(status_code=404, detail="User not found.")
        row2 = get_app_user_by_id(conn, user_id)
    return user_row_public(row2) if row2 else None


@app.delete("/api/settings/users/{user_id}")
def api_settings_users_delete(
    user_id: str,
    request: Request,
    admin_uid: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM app_users").fetchone()[0]
        if total <= 1:
            raise HTTPException(status_code=400, detail="Cannot delete the only user.")
        row = get_app_user_by_id(conn, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")
        if row["role"] == "admin" and count_admins(conn) <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete the last administrator.",
            )
        if not delete_app_user(conn, user_id):
            raise HTTPException(status_code=404, detail="User not found.")
    if user_id == admin_uid:
        request.session.clear()
    return {"ok": True}


def _alerts_severity_where(severity: str | None) -> tuple[str, tuple]:
    """Returns SQL WHERE fragment (without WHERE) and args; empty if no filter."""
    if severity is None or str(severity).lower() in ("", "all"):
        return "", ()
    s = str(severity).lower()
    if s == "high":
        return (
            "(LOWER(COALESCE(a.severity,'')) LIKE '%high%' OR LOWER(COALESCE(a.severity,'')) LIKE '%critical%')",
            (),
        )
    if s == "medium":
        return ("LOWER(COALESCE(a.severity,'')) LIKE '%medium%'", ())
    if s == "low":
        return (
            "NOT (LOWER(COALESCE(a.severity,'')) LIKE '%high%' OR LOWER(COALESCE(a.severity,'')) LIKE '%critical%' OR LOWER(COALESCE(a.severity,'')) LIKE '%medium%')",
            (),
        )
    return "", ()


def _alerts_search_like_pattern(raw: str) -> str:
    """Lowercased LIKE pattern with %wildcards%; escape % _ \\ for use with ESCAPE '\\'."""
    s = str(raw).strip().lower()
    s = s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{s}%"


def _alerts_where_sql(
    severity: str | None,
    tenant_names: list[str] | None,
    firewall_hostnames: list[str] | None,
    search: str | None = None,
    firewall_id: str | None = None,
) -> tuple[str, tuple]:
    """Full WHERE clause (including WHERE keyword) and bind values for alert list/count."""
    conditions: list[str] = []
    bind: list = []

    frag, extra = _alerts_severity_where(severity)
    if frag:
        conditions.append("(" + frag + ")")
    bind.extend(extra)

    tn = [str(x) for x in (tenant_names or []) if x is not None and str(x).strip() != ""]
    fh = [str(x) for x in (firewall_hostnames or []) if x is not None and str(x).strip() != ""]

    if tn:
        ph = ",".join("?" * len(tn))
        conditions.append(_sql_alerts_tenant_display() + " IN (" + ph + ")")
        bind.extend(tn)
    if fh:
        ph = ",".join("?" * len(fh))
        conditions.append(
            "COALESCE(NULLIF(fw.hostname, ''), NULLIF(fw.name, ''), '—') IN (" + ph + ")"
        )
        bind.extend(fh)

    fw_one = (firewall_id or "").strip()
    if fw_one:
        conditions.append("json_extract(a.managed_agent_json, '$') = ?")
        bind.append(fw_one)

    sq = str(search).strip() if search else ""
    if sq:
        like_pat = _alerts_search_like_pattern(sq)
        tenant_search_lower = _sql_alerts_tenant_search_lower()
        search_sql = (
            "("
            "LOWER(COALESCE(a.severity, '')) LIKE ? ESCAPE '\\' OR "
            "LOWER(COALESCE(a.description, '')) LIKE ? ESCAPE '\\' OR "
            "LOWER(COALESCE(a.category, '')) LIKE ? ESCAPE '\\' OR "
            "LOWER(COALESCE(a.id, '')) LIKE ? ESCAPE '\\' OR "
            + tenant_search_lower
            + " LIKE ? ESCAPE '\\' OR "
            "LOWER(COALESCE(NULLIF(fw.hostname, ''), NULLIF(fw.name, ''), '')) LIKE ? ESCAPE '\\' OR "
            "LOWER(COALESCE(a.raised_at, '')) LIKE ? ESCAPE '\\'"
            ")"
        )
        conditions.append(search_sql)
        bind.extend([like_pat] * 7)

    if not conditions:
        return "", tuple(bind)
    return " WHERE " + " AND ".join(conditions), tuple(bind)


@app.get("/api/dashboard")
def api_dashboard():
    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM firewalls) AS firewalls,
              (SELECT COUNT(*) FROM tenants) AS tenants,
              (SELECT COUNT(*) FROM licenses) AS licenses,
              (
                SELECT COUNT(*) FROM licenses l
                INNER JOIN license_subscriptions s ON s.serial_number = l.serial_number
                WHERE COALESCE(s.perpetual, 0) != 0
                   OR (
                     s.start_date IS NOT NULL
                     AND TRIM(s.start_date) != ''
                     AND s.end_date IS NOT NULL
                     AND TRIM(s.end_date) != ''
                     AND date(s.start_date) < date('now', 'localtime')
                     AND date(s.end_date) > date('now', 'localtime')
                   )
              ) AS licenses_subscription_active,
              (
                SELECT COUNT(*) FROM licenses l
                INNER JOIN license_subscriptions s ON s.serial_number = l.serial_number
                WHERE COALESCE(s.perpetual, 0) = 0
                  AND NOT (
                    s.start_date IS NOT NULL
                    AND TRIM(s.start_date) != ''
                    AND s.end_date IS NOT NULL
                    AND TRIM(s.end_date) != ''
                    AND date(s.start_date) < date('now', 'localtime')
                    AND date(s.end_date) > date('now', 'localtime')
                  )
              ) AS licenses_subscription_expired,
              (
                SELECT COUNT(*) FROM licenses l
                INNER JOIN license_subscriptions s ON s.serial_number = l.serial_number
                WHERE COALESCE(s.perpetual, 0) = 0
                  AND s.end_date IS NOT NULL
                  AND TRIM(s.end_date) != ''
                  AND (
                    (
                      date(s.end_date) > date('now', 'localtime')
                      AND date(s.end_date) <= date('now', 'localtime', '+90 days')
                    )
                    OR (
                      date(s.end_date) <= date('now', 'localtime')
                      AND date(s.end_date) >= date('now', 'localtime', '-30 days')
                    )
                  )
              ) AS licenses_subscription_expiring,
              (SELECT COUNT(*) FROM alerts) AS alerts,
              (SELECT COUNT(*) FROM firewalls WHERE connected = 1 AND suspended = 0) AS firewalls_online,
              (SELECT COUNT(*) FROM firewalls WHERE NOT (connected = 1 AND suspended = 0)) AS firewalls_offline,
              (SELECT COUNT(*) FROM firewalls WHERE suspended = 1) AS firewalls_suspended,
              (
                SELECT COUNT(*) FROM firewalls
                WHERE
                  LOWER(TRIM(COALESCE(managing_status, ''))) IN ('approvalpending', 'pendingapproval')
                  OR LOWER(TRIM(COALESCE(reporting_status, ''))) IN ('approvalpending', 'pendingapproval')
              ) AS firewalls_pending_approval,
              (SELECT COUNT(*) FROM alerts WHERE
                LOWER(COALESCE(severity,'')) LIKE '%high%'
                OR LOWER(COALESCE(severity,'')) LIKE '%critical%') AS alerts_high,
              (SELECT COUNT(*) FROM alerts WHERE LOWER(COALESCE(severity,'')) LIKE '%medium%') AS alerts_medium,
              (SELECT COUNT(*) FROM alerts a0 WHERE NOT (
                LOWER(COALESCE(a0.severity,'')) LIKE '%high%'
                OR LOWER(COALESCE(a0.severity,'')) LIKE '%critical%'
                OR LOWER(COALESCE(a0.severity,'')) LIKE '%medium%'
              )) AS alerts_low
            """
        )
        row = cur.fetchone()
        out = row_to_dict(row)
        bill_cur = conn.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(billing_type), ''), '—') AS billing_type,
                   COUNT(*) AS count
            FROM tenants
            GROUP BY COALESCE(NULLIF(TRIM(billing_type), ''), '—')
            ORDER BY count DESC, billing_type COLLATE NOCASE
            """
        )
        out["tenants_by_billing"] = [
            {"billing_type": b["billing_type"], "count": b["count"]} for b in bill_cur.fetchall()
        ]
        return out


@app.get("/api/firewalls")
def api_firewalls():
    tdisp = _sql_tenant_display_coalesced("t", "f.tenant_id")
    with get_db_with_sec() as conn:
        sql_fw = (
            """
            SELECT
              f.id,
              f.hostname,
              f.name,
              f.serial_number,
              f.model,
              f.firmware_version,
              f.connected,
              f.suspended,
              f.created_at,
              f.state_changed_at,
              f.last_sync,
              f.client_id,
              f.external_ipv4_addresses_json,
              f.geo_latitude,
              f.geo_longitude,
              f.managing_status,
              f.reporting_status,
              f.capabilities_json,
              """
            + tdisp
            + """ AS tenant_name,
              COALESCE(t.id, f.tenant_id) AS tenant_id,
              (
                SELECT COUNT(*) FROM alerts a
                WHERE json_extract(a.managed_agent_json, '$') = f.id
              ) AS alert_count,
              (
                SELECT EXISTS(
                  SELECT 1 FROM firewall_group_sync_status s
                  WHERE s.firewall_id = f.id
                )
              ) AS has_group_sync_status,
              (
                SELECT EXISTS(
                  SELECT 1 FROM firewall_group_sync_status s
                  WHERE s.firewall_id = f.id
                    AND LOWER(TRIM(COALESCE(s.status, ''))) = 'suspended'
                )
              ) AS group_sync_status_suspended,
              (
                SELECT u.upgrade_to_versions_json
                FROM firmware_upgrades u
                WHERE u.firewall_id = f.id
                LIMIT 1
              ) AS _upgrade_to_versions_json,
              COALESCE(
                (
                  SELECT
                    CASE
                      WHEN json_valid(u.upgrade_to_versions_json)
                      THEN json_array_length(u.upgrade_to_versions_json)
                      ELSE 0
                    END
                  FROM firmware_upgrades u
                  WHERE u.firewall_id = f.id
                ),
                0
              ) AS firmware_upgrade_count
            FROM firewalls f
            LEFT JOIN tenants t ON t.id = f.tenant_id
            ORDER BY COALESCE(f.hostname, f.name, f.serial_number)
            """
        )
        central_groups = _firewall_central_group_breadcrumbs_map(conn)
        cur = conn.execute(sql_fw)
        rows_out: list[dict] = []
        for r in cur.fetchall():
            d = row_to_dict(r)
            raw = d.pop("_upgrade_to_versions_json", None)
            d["firmware_available_updates"] = _upgrade_versions_from_json(raw)
            tid = d.get("tenant_id")
            fid = d.get("id")
            key = (str(tid).strip(), str(fid).strip()) if tid is not None and fid is not None else None
            d["central_group_breadcrumbs"] = central_groups.get(key, []) if key else []
            rows_out.append(d)
        return rows_out


class FirewallApproveBatchBody(BaseModel):
    """Approve management for firewalls that are in Sophos Central pending-approval state."""

    firewall_ids: list[str] = Field(default_factory=list)


class FirewallFirmwareUpgradeItemBody(BaseModel):
    firewall_id: str = Field(min_length=1)
    upgrade_to_version: str | None = None


class FirewallFirmwareUpgradeBatchBody(BaseModel):
    """Schedule firmware upgrades via Sophos Central (per credential/tenant batch)."""

    items: list[FirewallFirmwareUpgradeItemBody]
    scheduled_at: str | None = Field(default=None, max_length=80)


class FirewallDeleteLocalBatchBody(BaseModel):
    """Remove firewall rows from the local SQLite cache only (not Sophos Central)."""

    firewall_ids: list[str] = Field(default_factory=list)


@app.post("/api/firewalls/delete-local-batch")
def api_firewalls_delete_local_batch(
    body: FirewallDeleteLocalBatchBody,
    _: str = Depends(admin_user_id_dep),
):
    """Delete selected firewalls from the local database only. They reappear after the next sync if still in Central."""
    ids = [str(x).strip() for x in body.firewall_ids if x is not None and str(x).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="firewall_ids must not be empty.")
    uniq = list(dict.fromkeys(ids))
    ph = ",".join("?" * len(uniq))
    with get_db() as conn:
        cur = conn.execute(
            "SELECT id FROM firewalls WHERE id IN (" + ph + ")",
            uniq,
        )
        found = [str(r[0]) for r in cur.fetchall()]
        found_set = set(found)
        not_found = [i for i in uniq if i not in found_set]
        if found:
            ph2 = ",".join("?" * len(found))
            conn.execute(
                "DELETE FROM firmware_upgrades WHERE firewall_id IN (" + ph2 + ")",
                found,
            )
            conn.execute("DELETE FROM firewalls WHERE id IN (" + ph2 + ")", found)
        conn.commit()
    return {"deleted": found, "not_found": not_found}


@app.post("/api/firewalls/approve-batch")
def api_firewalls_approve_batch(
    body: FirewallApproveBatchBody,
    _: str = Depends(admin_user_id_dep),
):
    """Approve selected firewalls via Central API, then sync each credential that had a success."""
    ids = [str(x).strip() for x in body.firewall_ids if x is not None and str(x).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="firewall_ids must not be empty.")
    approved: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = []
    sync_cred_ids: set[str] = set()

    with get_db() as conn:
        for fw_id in ids:
            row = conn.execute(
                """
                SELECT id, tenant_id, client_id, hostname, name, managing_status, reporting_status
                FROM firewalls WHERE id = ?
                """,
                (fw_id,),
            ).fetchone()
            if not row:
                errors.append({"id": fw_id, "detail": "Firewall not found"})
                continue
            if not _fw_status_pending_approval(row["managing_status"], row["reporting_status"]):
                skipped.append({"id": fw_id, "detail": "Not in pending approval state"})
                continue
            fw_client_id = (row["client_id"] or "").strip()
            fw_tenant_id = (row["tenant_id"] or "").strip()
            if not fw_client_id:
                errors.append(
                    {
                        "id": fw_id,
                        "detail": "Firewall has no synced API client id; run a Central sync first.",
                    }
                )
                continue
            if not fw_tenant_id:
                errors.append({"id": fw_id, "detail": "Firewall has no tenant id."})
                continue

            with get_secrets_db() as sconn:
                cred_pair = get_stored_credential_secrets_by_client_id(sconn, fw_client_id)
                cred_row_id = get_credential_id_by_client_id(sconn, fw_client_id)
            if not cred_pair:
                errors.append(
                    {
                        "id": fw_id,
                        "detail": "No stored Central credential matches this firewall's API client id.",
                    }
                )
                continue

            oauth_cid, oauth_secret = cred_pair
            try:
                _approve_firewall_management_on_central(
                    firewall_id=fw_id,
                    tenant_id=fw_tenant_id,
                    oauth_client_id=oauth_cid,
                    oauth_client_secret=oauth_secret,
                )
            except HTTPException as he:
                detail = he.detail
                msg = detail if isinstance(detail, str) else str(detail)
                errors.append({"id": fw_id, "detail": msg})
                continue

            label = row["hostname"] or row["name"] or fw_id
            approved.append({"id": fw_id, "label": str(label)[:500]})
            if cred_row_id:
                sync_cred_ids.add(cred_row_id)

    sync_results: list[dict] = []
    for cred_id in sorted(sync_cred_ids):
        try:
            with get_db() as central_conn:
                result = run_credential_sync(cred_id, central_conn=central_conn, trigger="post-approve")
            sync_results.append(
                {
                    "credential_id": cred_id,
                    "ok": result.success,
                    "error": result.error,
                }
            )
        except Exception as e:
            sync_results.append(
                {
                    "credential_id": cred_id,
                    "ok": False,
                    "error": str(e) or type(e).__name__,
                }
            )

    return {
        "approved": approved,
        "skipped": skipped,
        "errors": errors,
        "credential_syncs": sync_results,
    }


@app.post("/api/firewalls/firmware-upgrade-batch")
def api_firewalls_firmware_upgrade_batch(
    body: FirewallFirmwareUpgradeBatchBody,
    _: str = Depends(admin_user_id_dep),
):
    """Schedule or run firmware upgrades on Central for selected firewalls (grouped by OAuth client + tenant)."""
    scheduled_utc = _parse_scheduled_at_iso_to_utc(body.scheduled_at)
    upgrade_at_str = _sophos_upgrade_at_string(scheduled_utc) if scheduled_utc else None

    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    skipped: list[dict] = []
    errors: list[dict] = []

    with get_db() as conn:
        for it in body.items:
            fw_id = str(it.firewall_id or "").strip()
            if not fw_id:
                errors.append({"id": "", "detail": "Missing firewall id."})
                continue
            target_ver = (it.upgrade_to_version or "").strip()
            if not target_ver:
                skipped.append({"id": fw_id, "detail": "No upgrade version selected (skipped)."})
                continue

            row = conn.execute(
                """
                SELECT f.id, f.tenant_id, f.client_id, f.hostname, f.name
                FROM firewalls f
                WHERE f.id = ?
                """,
                (fw_id,),
            ).fetchone()
            if not row:
                errors.append({"id": fw_id, "detail": "Firewall not found."})
                continue

            up_row = conn.execute(
                "SELECT upgrade_to_versions_json FROM firmware_upgrades WHERE firewall_id = ?",
                (fw_id,),
            ).fetchone()
            available = _upgrade_versions_from_json(
                up_row["upgrade_to_versions_json"] if up_row else None
            )
            if target_ver not in available:
                errors.append(
                    {
                        "id": fw_id,
                        "detail": f"Version {target_ver!r} is not in the available upgrade list for this firewall.",
                    }
                )
                continue

            fw_client_id = (row["client_id"] or "").strip()
            fw_tenant_id = (row["tenant_id"] or "").strip()
            if not fw_client_id:
                errors.append(
                    {
                        "id": fw_id,
                        "detail": "Firewall has no synced API client id; run a Central sync first.",
                    }
                )
                continue
            if not fw_tenant_id:
                errors.append({"id": fw_id, "detail": "Firewall has no tenant id."})
                continue

            with get_secrets_db() as sconn:
                cred_pair = get_stored_credential_secrets_by_client_id(sconn, fw_client_id)
                cred_row_id = get_credential_id_by_client_id(sconn, fw_client_id)
            if not cred_pair:
                errors.append(
                    {
                        "id": fw_id,
                        "detail": "No stored Central credential matches this firewall's API client id.",
                    }
                )
                continue

            entry: dict = {"id": fw_id, "upgradeToVersion": target_ver}
            if upgrade_at_str:
                entry["upgradeAt"] = upgrade_at_str
            groups[(fw_client_id, fw_tenant_id)].append(
                {"payload": entry, "cred_row_id": cred_row_id, "oauth": cred_pair}
            )

    scheduled: list[dict] = []
    sync_cred_ids: set[str] = set()

    for (oauth_cid, fw_tenant_id), entries in groups.items():
        oauth_secret = entries[0]["oauth"][1]
        cred_ids = {e["cred_row_id"] for e in entries if e.get("cred_row_id")}
        upgrade_dicts = [e["payload"] for e in entries]
        try:
            cresp = _post_firmware_upgrade_actions_on_central(
                oauth_client_id=oauth_cid,
                oauth_client_secret=oauth_secret,
                tenant_id=fw_tenant_id,
                upgrade_dicts=upgrade_dicts,
            )
        except HTTPException as he:
            detail = he.detail
            msg = detail if isinstance(detail, str) else str(detail)
            for e in entries:
                scheduled.append({"id": e["payload"]["id"], "ok": False, "detail": msg})
            continue

        if not cresp.success:
            msg = _central_api_error_message(cresp)
            for e in entries:
                scheduled.append({"id": e["payload"]["id"], "ok": False, "detail": msg})
            continue

        for e in entries:
            scheduled.append({"id": e["payload"]["id"], "ok": True, "detail": None})
        for cid in cred_ids:
            if cid:
                sync_cred_ids.add(str(cid))

    sync_results: list[dict] = []
    for cred_id in sorted(sync_cred_ids):
        try:
            with get_db() as central_conn:
                result = run_credential_sync(
                    cred_id, central_conn=central_conn, trigger="post-firmware-upgrade"
                )
            sync_results.append(
                {
                    "credential_id": cred_id,
                    "ok": result.success,
                    "error": result.error,
                }
            )
        except Exception as e:
            sync_results.append(
                {
                    "credential_id": cred_id,
                    "ok": False,
                    "error": str(e) or type(e).__name__,
                }
            )

    return {
        "scheduled": scheduled,
        "skipped": skipped,
        "errors": errors,
        "credential_syncs": sync_results,
    }


@app.get("/api/geocode/search")
def api_geocode_search(
    q: str = Query(default="", min_length=1, max_length=500),
    limit: int = Query(default=8, ge=1, le=10),
    _: str = Depends(current_user_id_dep),
):
    """Address suggestions / forward geocoding (Nominatim)."""
    results = _nominatim_search(q, limit=limit)
    return {"results": results}


class FirewallLocationBody(BaseModel):
    """Set firewall map coordinates. Send either a street address (geocoded) or lat/lon."""

    address: str | None = Field(default=None, max_length=500)
    latitude: float | None = None
    longitude: float | None = None


class FirewallLabelBody(BaseModel):
    """Display name / label for the firewall (PATCHed to Sophos Central as ``name``)."""

    name: str = Field(max_length=256)


def _build_central_full_url(
    session: CentralSession,
    url_path: str,
    *,
    url_base: str | None = None,
    params: dict | None = None,
) -> str:
    """
    Build an absolute Central API URL. Uses the same rules as CentralSession._get_url
    with correct (path, base) ordering — CentralSession.patch passes those arguments reversed.
    """
    if session.whoami is None:
        raise HTTPException(status_code=502, detail="Central whoami is missing after authentication.")
    if session.whoami.idType == "tenant":
        base = url_base or session.whoami.data_region_url()
    else:
        base = url_base or session.whoami.global_url()
    if not base:
        raise HTTPException(
            status_code=502,
            detail="Could not determine Sophos Central API base URL for this credential.",
        )
    if params:
        path_with_q = f"{url_path}?{urlencode(params, doseq=True)}"
    else:
        path_with_q = url_path
    return urljoin(base, path_with_q)


def _central_api_error_message(cresp: CentralResponse) -> str:
    data = cresp.data
    if isinstance(data, dict):
        for key in ("message", "error", "detail"):
            v = data.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    if cresp.error_message and str(cresp.error_message).strip():
        return str(cresp.error_message).strip()
    return f"Sophos Central API error (HTTP {cresp.status_code})"


def _fw_status_pending_approval(managing: str | None, reporting: str | None) -> bool:
    def one(val: str | None) -> bool:
        s = (val or "").strip().lower()
        return s in ("approvalpending", "pendingapproval")

    return one(managing) or one(reporting)


def _central_firewall_api_context(
    *,
    oauth_client_id: str,
    oauth_client_secret: str,
    tenant_id: str,
    unsupported_phrase: str = "this action",
) -> tuple[CentralSession, str, str | None, str | None]:
    """Authenticate and resolve data-region URL + tenant/org headers for firewall APIs."""
    session = CentralSession(oauth_client_id.strip(), oauth_client_secret)
    auth = session.authenticate()
    if not auth.success:
        raise HTTPException(
            status_code=502,
            detail=auth.message or "Sophos Central authentication failed.",
        )
    w = session.whoami
    id_type = w.idType
    url_base: str | None = None
    tenant_hdr: str | None = None
    org_hdr: str | None = None

    if id_type == "tenant":
        if tenant_id != w.id:
            raise HTTPException(
                status_code=400,
                detail="This firewall belongs to a different tenant than the stored API credential.",
            )
        url_base = w.data_region_url()
        tenant_hdr = w.id
    elif id_type == "partner":
        tenant_hdr = tenant_id
        with get_db() as conn:
            trow = conn.execute(
                "SELECT api_host FROM tenants WHERE id = ?",
                (tenant_id,),
            ).fetchone()
        if not trow or not str(trow["api_host"] or "").strip():
            raise HTTPException(
                status_code=503,
                detail="Tenant API host is missing from the local database; sync this tenant from a partner credential first.",
            )
        url_base = str(trow["api_host"]).strip()
    elif id_type == "organization":
        tenant_hdr = tenant_id
        org_hdr = w.id
        with get_db() as conn:
            trow = conn.execute(
                "SELECT api_host FROM tenants WHERE id = ?",
                (tenant_id,),
            ).fetchone()
        if not trow or not str(trow["api_host"] or "").strip():
            raise HTTPException(
                status_code=503,
                detail="Tenant API host is missing from the local database; sync this tenant from an organization credential first.",
            )
        url_base = str(trow["api_host"]).strip()
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Sophos Central credential type for {unsupported_phrase}: {id_type!r}.",
        )

    return session, url_base, tenant_hdr, org_hdr


def _approve_firewall_management_on_central(
    *,
    firewall_id: str,
    tenant_id: str,
    oauth_client_id: str,
    oauth_client_secret: str,
) -> None:
    """POST approveManagement on Sophos Central (same tenancy / region rules as geo PATCH)."""
    session, url_base, tenant_hdr, org_hdr = _central_firewall_api_context(
        oauth_client_id=oauth_client_id,
        oauth_client_secret=oauth_client_secret,
        tenant_id=tenant_id,
        unsupported_phrase="management approval",
    )

    full_url = _build_central_full_url(
        session, f"/firewall/v1/firewalls/{firewall_id}/action", url_base=url_base
    )
    headers = {
        "Authorization": f"Bearer {session.jwt}",
        "Content-Type": "application/json",
    }
    if tenant_hdr:
        headers["X-Tenant-ID"] = tenant_hdr
    if org_hdr:
        headers["X-Organization-ID"] = org_hdr
    payload = {"action": "approveManagement"}
    try:
        r = requests.post(full_url, headers=headers, json=payload, timeout=30)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Sophos Central request failed: {e}") from e

    cresp = CentralResponse(r)
    if not cresp.success:
        raise HTTPException(status_code=502, detail=_central_api_error_message(cresp))


def _parse_scheduled_at_iso_to_utc(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def _sophos_upgrade_at_string(dt: datetime) -> str:
    """Sophos documents ``yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`` (millisecond precision)."""
    u = dt.astimezone(timezone.utc)
    ms = u.microsecond // 1000
    return u.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def _post_firmware_upgrade_actions_on_central(
    *,
    oauth_client_id: str,
    oauth_client_secret: str,
    tenant_id: str,
    upgrade_dicts: list[dict],
) -> CentralResponse:
    """POST /firewall/v1/firewalls/actions/firmware-upgrade (single object or batch)."""
    session, url_base, tenant_hdr, org_hdr = _central_firewall_api_context(
        oauth_client_id=oauth_client_id,
        oauth_client_secret=oauth_client_secret,
        tenant_id=tenant_id,
        unsupported_phrase="firmware upgrade",
    )
    # API requires `{ "firewalls": [...] }` even for a single firewall (see firewall-v1 OpenAPI).
    json_body: dict = {"firewalls": upgrade_dicts}
    full_url = _build_central_full_url(
        session, "/firewall/v1/firewalls/actions/firmware-upgrade", url_base=url_base
    )
    headers = {
        "Authorization": f"Bearer {session.jwt}",
        "Content-Type": "application/json",
    }
    if tenant_hdr:
        headers["X-Tenant-ID"] = tenant_hdr
    if org_hdr:
        headers["X-Organization-ID"] = org_hdr
    try:
        r = requests.post(full_url, headers=headers, json=json_body, timeout=60)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Sophos Central request failed: {e}") from e
    return CentralResponse(r)


def _patch_firewall_json_on_central(
    *,
    firewall_id: str,
    tenant_id: str,
    oauth_client_id: str,
    oauth_client_secret: str,
    json_body: dict,
    unsupported_phrase: str,
) -> None:
    """PATCH ``/firewall/v1/firewalls/{id}`` on Sophos Central (geo, name, etc.)."""
    session, url_base, tenant_hdr, org_hdr = _central_firewall_api_context(
        oauth_client_id=oauth_client_id,
        oauth_client_secret=oauth_client_secret,
        tenant_id=tenant_id,
        unsupported_phrase=unsupported_phrase,
    )
    full_url = _build_central_full_url(
        session, f"/firewall/v1/firewalls/{firewall_id}", url_base=url_base
    )
    headers = {
        "Authorization": f"Bearer {session.jwt}",
        "Content-Type": "application/json",
    }
    if tenant_hdr:
        headers["X-Tenant-ID"] = tenant_hdr
    if org_hdr:
        headers["X-Organization-ID"] = org_hdr
    try:
        r = requests.patch(full_url, headers=headers, json=json_body, timeout=30)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Sophos Central request failed: {e}") from e
    cresp = CentralResponse(r)
    if not cresp.success:
        raise HTTPException(status_code=502, detail=_central_api_error_message(cresp))


def _push_firewall_geolocation_to_central(
    *,
    firewall_id: str,
    tenant_id: str,
    geo_latitude: str,
    geo_longitude: str,
    oauth_client_id: str,
    oauth_client_secret: str,
) -> None:
    """PATCH firewall geoLocation on Sophos Central using the same tenancy/region rules as sync."""
    _patch_firewall_json_on_central(
        firewall_id=firewall_id,
        tenant_id=tenant_id,
        oauth_client_id=oauth_client_id,
        oauth_client_secret=oauth_client_secret,
        json_body={
            "geoLocation": {
                "latitude": geo_latitude,
                "longitude": geo_longitude,
            }
        },
        unsupported_phrase="location update",
    )


@app.patch("/api/firewalls/{firewall_id}/location")
def api_firewall_patch_location(
    firewall_id: str,
    body: FirewallLocationBody,
    _: str = Depends(current_user_id_dep),
):
    addr = (body.address or "").strip()
    lat: float | None = body.latitude
    lon: float | None = body.longitude

    if addr:
        hits = _nominatim_search(addr, limit=1)
        if not hits:
            raise HTTPException(
                status_code=400,
                detail="No location found for that address. Try different wording or enter latitude and longitude.",
            )
        lat = hits[0]["lat"]
        lon = hits[0]["lon"]
    elif lat is None or lon is None:
        raise HTTPException(
            status_code=400,
            detail="Provide a street address or both latitude and longitude.",
        )

    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=400, detail="Latitude or longitude is out of range.")

    lat_s = f"{lat:.7f}".rstrip("0").rstrip(".")
    lon_s = f"{lon:.7f}".rstrip("0").rstrip(".")

    with get_db() as conn:
        row = conn.execute(
            "SELECT id, tenant_id, client_id FROM firewalls WHERE id = ?",
            (firewall_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Firewall not found")
        fw_client_id = (row["client_id"] or "").strip()
        fw_tenant_id = (row["tenant_id"] or "").strip()
        if not fw_client_id:
            raise HTTPException(
                status_code=400,
                detail="This firewall has no synced API client id; run a Central sync before setting location in Sophos.",
            )
        if not fw_tenant_id:
            raise HTTPException(status_code=400, detail="Firewall has no tenant id.")

    with get_secrets_db() as sconn:
        cred_pair = get_stored_credential_secrets_by_client_id(sconn, fw_client_id)
    if not cred_pair:
        raise HTTPException(
            status_code=400,
            detail="No stored Central credential matches this firewall's API client id; add the same OAuth client under Settings.",
        )
    oauth_cid, oauth_secret = cred_pair

    _push_firewall_geolocation_to_central(
        firewall_id=firewall_id,
        tenant_id=fw_tenant_id,
        geo_latitude=lat_s,
        geo_longitude=lon_s,
        oauth_client_id=oauth_cid,
        oauth_client_secret=oauth_secret,
    )

    with get_db() as conn:
        conn.execute(
            "UPDATE firewalls SET geo_latitude = ?, geo_longitude = ? WHERE id = ?",
            (lat_s, lon_s, firewall_id),
        )
        conn.commit()

    return {"ok": True, "geo_latitude": lat_s, "geo_longitude": lon_s}


@app.patch("/api/firewalls/{firewall_id}/label")
def api_firewall_patch_label(
    firewall_id: str,
    body: FirewallLabelBody,
    _: str = Depends(current_user_id_dep),
):
    """Set firewall display name on Sophos Central (PATCH ``name``) and update the local cache."""
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name must not be empty.")

    with get_db() as conn:
        row = conn.execute(
            "SELECT id, tenant_id, client_id FROM firewalls WHERE id = ?",
            (firewall_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Firewall not found")
        fw_client_id = (row["client_id"] or "").strip()
        fw_tenant_id = (row["tenant_id"] or "").strip()
        if not fw_client_id:
            raise HTTPException(
                status_code=400,
                detail="This firewall has no synced API client id; run a Central sync before changing the label in Sophos.",
            )
        if not fw_tenant_id:
            raise HTTPException(status_code=400, detail="Firewall has no tenant id.")

    with get_secrets_db() as sconn:
        cred_pair = get_stored_credential_secrets_by_client_id(sconn, fw_client_id)
    if not cred_pair:
        raise HTTPException(
            status_code=400,
            detail="No stored Central credential matches this firewall's API client id; add the same OAuth client under Settings.",
        )
    oauth_cid, oauth_secret = cred_pair

    _patch_firewall_json_on_central(
        firewall_id=firewall_id,
        tenant_id=fw_tenant_id,
        oauth_client_id=oauth_cid,
        oauth_client_secret=oauth_secret,
        json_body={"name": new_name},
        unsupported_phrase="label update",
    )

    with get_db() as conn:
        conn.execute(
            "UPDATE firewalls SET name = ? WHERE id = ?",
            (new_name, firewall_id),
        )
        conn.commit()

    return {"ok": True, "name": new_name}


@app.get("/api/firmware-versions")
def api_firmware_versions():
    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT version FROM firmware_versions
            ORDER BY version COLLATE NOCASE
            """
        )
        return {"versions": [row["version"] for row in cur.fetchall()]}


@app.get("/api/firmware-version-details")
def api_firmware_version_details(
    versions: list[str] = Query(default_factory=list),
    _: str = Depends(current_user_id_dep),
):
    """Release notes / metadata from ``firmware_versions`` for UI (e.g. batch upgrade modal)."""
    seen: set[str] = set()
    ordered: list[str] = []
    for raw in versions:
        v = str(raw or "").strip()
        if not v or v in seen:
            continue
        seen.add(v)
        ordered.append(v)

    details: list[dict] = []
    with get_db() as conn:
        for ver in ordered:
            vr = conn.execute(
                """
                SELECT version, size, bugs_json, news_json, first_sync, last_sync
                FROM firmware_versions
                WHERE version = ?
                """,
                (ver,),
            ).fetchone()
            if vr:
                d = row_to_dict(vr)
                bugs = _json_string_list(d.pop("bugs_json", None))
                news = _json_string_list(d.pop("news_json", None))
                d["bugs"] = bugs
                d["news"] = news
                d["in_database"] = True
            else:
                d = {
                    "version": ver,
                    "size": None,
                    "bugs": [],
                    "news": [],
                    "first_sync": None,
                    "last_sync": None,
                    "in_database": False,
                }
            details.append(d)

    return {"versions": ordered, "version_details": details}


@app.get("/api/firewalls/{firewall_id}/firmware-upgrades")
def api_firewall_firmware_upgrades(firewall_id: str):
    with get_db() as conn:
        fw = conn.execute(
            "SELECT id, hostname, name FROM firewalls WHERE id = ?",
            (firewall_id,),
        ).fetchone()
        if not fw:
            raise HTTPException(status_code=404, detail="Firewall not found")
        hostname = (fw["hostname"] or fw["name"] or "").strip() or "—"
        up = conn.execute(
            """
            SELECT current_version, upgrade_to_versions_json
            FROM firmware_upgrades
            WHERE firewall_id = ?
            """,
            (firewall_id,),
        ).fetchone()

        if not up:
            return {
                "firewall_id": firewall_id,
                "hostname": hostname,
                "current_version": None,
                "available_versions": [],
                "version_details": [],
            }

        versions = _upgrade_versions_from_json(up["upgrade_to_versions_json"])

        details: list[dict] = []
        for ver in versions:
            vr = conn.execute(
                """
                SELECT version, size, bugs_json, news_json, first_sync, last_sync
                FROM firmware_versions
                WHERE version = ?
                """,
                (ver,),
            ).fetchone()
            if vr:
                d = row_to_dict(vr)
                bugs = _json_string_list(d.pop("bugs_json", None))
                news = _json_string_list(d.pop("news_json", None))
                d["bugs"] = bugs
                d["news"] = news
                d["in_database"] = True
            else:
                d = {
                    "version": ver,
                    "size": None,
                    "bugs": [],
                    "news": [],
                    "first_sync": None,
                    "last_sync": None,
                    "in_database": False,
                }
            details.append(d)

        return {
            "firewall_id": firewall_id,
            "hostname": hostname,
            "current_version": up["current_version"],
            "available_versions": versions,
            "version_details": details,
        }


@app.get("/api/tenants")
def api_tenants():
    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT
              id,
              show_as,
              name,
              data_geography,
              data_region,
              billing_type,
              status,
              api_host,
              updated_at,
              (
                SELECT COUNT(*) FROM firewalls f
                WHERE f.tenant_id = tenants.id
              ) AS firewall_count
            FROM tenants
            ORDER BY name COLLATE NOCASE
            """
        )
        rows = [row_to_dict(r) for r in cur.fetchall()]
        seen = {str(r["id"]) for r in rows if r.get("id") is not None}
        orphan_cur = conn.execute(
            """
            SELECT DISTINCT x.tenant_id FROM (
              SELECT tenant_id FROM firewalls
              WHERE tenant_id IS NOT NULL AND TRIM(tenant_id) != ''
              UNION
              SELECT tenant_id FROM licenses
              WHERE tenant_id IS NOT NULL AND TRIM(tenant_id) != ''
              UNION
              SELECT tenant_id FROM alerts
              WHERE tenant_id IS NOT NULL AND TRIM(tenant_id) != ''
            ) AS x
            WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id)
            """
        )
        orphan_ids = [r[0] for r in orphan_cur.fetchall() if r[0]]
        orphan_fw_counts: dict[str, int] = {}
        for otid in orphan_ids:
            if str(otid) in seen:
                continue
            n = conn.execute(
                "SELECT COUNT(*) FROM firewalls WHERE tenant_id = ?",
                (otid,),
            ).fetchone()[0]
            orphan_fw_counts[str(otid)] = int(n)
    with get_secrets_db() as sconn:
        for d in rows:
            tid = d.get("id")
            if tid is None:
                continue
            if d.get("name") != tid:
                continue
            label = credential_name_for_tenant_client_id(sconn, str(tid))
            if label:
                d["name"] = label
                d["show_as"] = label
        for otid in orphan_ids:
            sid = str(otid)
            if sid in seen:
                continue
            label = credential_name_for_tenant_client_id(sconn, sid)
            display = label or sid
            rows.append(
                {
                    "id": otid,
                    "show_as": display,
                    "name": display,
                    "data_geography": None,
                    "data_region": None,
                    "billing_type": "—",
                    "status": "—",
                    "api_host": "—",
                    "updated_at": "",
                    "firewall_count": orphan_fw_counts.get(sid, 0),
                }
            )
    rows.sort(key=lambda r: str(r.get("name") or "").casefold())
    return rows


@app.get("/api/firewall-groups")
def api_firewall_groups():
    """Rows from ``firewall_groups`` with tenant label, up to 3-segment breadcrumb, firewall count, and sync-status row count."""
    tdisp = _sql_tenant_display_coalesced("t", "g.tenant_id")
    with get_db_with_sec() as conn:
        sql_fg = (
            """
            SELECT
              g.id,
              g.tenant_id,
              g.name AS group_name,
              p.name AS parent_name,
              pp.name AS grandparent_name,
              g.locked_by_managing_account,
              g.last_sync,
              g.updated_at,
              COALESCE(g.firewalls_total, g.firewalls_items_count, 0) AS firewall_count,
              COALESCE(
                (SELECT COUNT(*) FROM firewall_group_sync_status s WHERE s.group_id = g.id),
                0
              ) AS sync_issues_count,
              """
            + tdisp
            + """ AS tenant_name
            FROM firewall_groups g
            LEFT JOIN firewall_groups p ON p.id = g.parent_group_id
            LEFT JOIN firewall_groups pp ON pp.id = p.parent_group_id
            LEFT JOIN tenants t ON t.id = g.tenant_id
            ORDER BY
              COALESCE("""
            + tdisp
            + """, '') COLLATE NOCASE,
              COALESCE(pp.name, '') COLLATE NOCASE,
              COALESCE(p.name, '') COLLATE NOCASE,
              COALESCE(g.name, '') COLLATE NOCASE
            """
        )
        cur = conn.execute(sql_fg)
        rows_raw = [row_to_dict(r) for r in cur.fetchall()]

    out: list[dict] = []
    for d in rows_raw:
        tenant_name = d.get("tenant_name")
        if tenant_name is None or str(tenant_name).strip() == "":
            tenant_name = "—"
        else:
            tenant_name = str(tenant_name).strip()
        gp = (d.get("grandparent_name") or "").strip() or None
        p = (d.get("parent_name") or "").strip() or None
        leaf = (d.get("group_name") or "").strip() or None
        parts = [x for x in (gp, p, leaf) if x]
        if not parts:
            parts = ["—"]
        elif len(parts) > 3:
            parts = parts[-3:]
        breadcrumb = " › ".join(parts)
        locked = d.get("locked_by_managing_account")
        locked_label = "Yes" if locked in (1, True, "1") else "No"
        try:
            fc_i = int(d.get("firewall_count") or 0)
        except (TypeError, ValueError):
            fc_i = 0
        try:
            sic = int(d.get("sync_issues_count") or 0)
        except (TypeError, ValueError):
            sic = 0
        out.append(
            {
                "id": d.get("id"),
                "tenant_id": d.get("tenant_id"),
                "tenant_name": tenant_name,
                "group_name": leaf if leaf else "—",
                "parent_display": p if p else "—",
                "breadcrumb": breadcrumb,
                "breadcrumb_segments": parts,
                "firewall_count": fc_i,
                "sync_issues_count": sic,
                "locked_label": locked_label,
                "last_sync": d.get("last_sync") or "",
                "updated_at": d.get("updated_at") or "",
            }
        )
    return out


@app.get("/api/licenses")
def api_licenses():
    tdisp = _sql_tenant_display_coalesced("t", "l.tenant_id")
    managed_by = _sql_tenant_display_coalesced("t", "fwh.tenant_id")
    with get_db_with_sec() as conn:
        sql_lic = (
            """
            SELECT
              l.serial_number,
              l.tenant_id,
              l.model,
              l.model_type,
              l.last_seen_at,
              l.partner_id,
              l.organization_id,
              """
            + tdisp
            + """ AS tenant_name,
              (
                SELECT COUNT(*) FROM license_subscriptions s
                WHERE s.serial_number = l.serial_number
              ) AS subscription_count,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM license_subscriptions s
                  WHERE s.serial_number = l.serial_number
                    AND s.start_date IS NOT NULL
                    AND TRIM(s.start_date) != ''
                    AND s.end_date IS NOT NULL
                    AND TRIM(s.end_date) != ''
                    AND date(s.start_date) < date('now', 'localtime')
                    AND date(s.end_date) > date('now', 'localtime')
                )
                THEN 'Active'
                ELSE 'Expired'
              END AS state,
              (
                SELECT
                  CASE
                    WHEN TRIM(COALESCE(fwh.hostname, '')) != '' THEN TRIM(fwh.hostname)
                    WHEN TRIM(COALESCE(fwh.name, '')) != '' THEN TRIM(fwh.name)
                    ELSE NULL
                  END
                FROM firewalls fwh
                WHERE fwh.serial_number = l.serial_number
                LIMIT 1
              ) AS firewall_host_label,
              (
                SELECT """
            + managed_by
            + """
                FROM firewalls fwh
                LEFT JOIN tenants t ON t.id = fwh.tenant_id
                WHERE fwh.serial_number = l.serial_number
                LIMIT 1
              ) AS managed_by_tenant
            FROM licenses l
            LEFT JOIN tenants t ON t.id = l.tenant_id
            ORDER BY l.serial_number COLLATE NOCASE
            """
        )
        cur = conn.execute(sql_lic)
        return [row_to_dict(r) for r in cur.fetchall()]


@app.get("/api/licenses-detailed")
def api_licenses_detailed():
    """One row per license–subscription pair (LEFT JOIN: licenses without subscriptions appear once)."""
    tdisp = _sql_tenant_display_coalesced("t", "l.tenant_id")
    managed_by = _sql_tenant_display_coalesced("tn", "fwh.tenant_id")
    with get_db_with_sec() as conn:
        sql_lic_d = (
            """
            SELECT
              l.serial_number,
              l.tenant_id,
              l.model,
              l.model_type,
              l.last_seen_at,
              l.partner_id,
              l.organization_id,
              """
            + tdisp
            + """ AS tenant_name,
              (
                SELECT
                  CASE
                    WHEN TRIM(COALESCE(fwh.hostname, '')) != '' THEN TRIM(fwh.hostname)
                    WHEN TRIM(COALESCE(fwh.name, '')) != '' THEN TRIM(fwh.name)
                    ELSE NULL
                  END
                FROM firewalls fwh
                WHERE fwh.serial_number = l.serial_number
                LIMIT 1
              ) AS firewall_host_label,
              (
                SELECT """
            + managed_by
            + """
                FROM firewalls fwh
                LEFT JOIN tenants tn ON tn.id = fwh.tenant_id
                WHERE fwh.serial_number = l.serial_number
                LIMIT 1
              ) AS managed_by_tenant,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM license_subscriptions s_agg
                  WHERE s_agg.serial_number = l.serial_number
                    AND s_agg.start_date IS NOT NULL
                    AND TRIM(s_agg.start_date) != ''
                    AND s_agg.end_date IS NOT NULL
                    AND TRIM(s_agg.end_date) != ''
                    AND date(s_agg.start_date) < date('now', 'localtime')
                    AND date(s_agg.end_date) > date('now', 'localtime')
                )
                THEN 'Active'
                ELSE 'Expired'
              END AS license_state,
              s.id AS subscription_id,
              s.license_identifier,
              s.product_code,
              s.product_name,
              s.start_date,
              s.end_date,
              s.perpetual,
              s.type AS subscription_type,
              s.quantity,
              s.usage_count,
              s.unlimited,
              CASE
                WHEN s.id IS NULL THEN NULL
                WHEN COALESCE(s.perpetual, 0) != 0 THEN 'Active'
                WHEN s.start_date IS NOT NULL
                  AND TRIM(s.start_date) != ''
                  AND s.end_date IS NOT NULL
                  AND TRIM(s.end_date) != ''
                  AND date(s.start_date) < date('now', 'localtime')
                  AND date(s.end_date) > date('now', 'localtime')
                THEN 'Active'
                ELSE 'Expired'
              END AS subscription_state
            FROM licenses l
            LEFT JOIN tenants t ON t.id = l.tenant_id
            LEFT JOIN license_subscriptions s ON s.serial_number = l.serial_number
            ORDER BY l.serial_number COLLATE NOCASE,
              (s.product_name IS NULL),
              s.product_name COLLATE NOCASE,
              s.id COLLATE NOCASE
            """
        )
        cur = conn.execute(sql_lic_d)
        return [row_to_dict(r) for r in cur.fetchall()]


@app.get("/api/alerts/facets")
def api_alerts_facets(
    severity: str | None = Query(
        default=None,
        description="Match dashboard severity filter: high, medium, low, or omit for all",
    ),
):
    """Distinct tenant names and firewall host labels for facet filters."""
    where_sql, bind = _alerts_where_sql(severity, None, None)
    base_from = """
        FROM alerts a
        LEFT JOIN tenants t ON t.id = a.tenant_id
    """
    alerts_tenant_disp = _sql_alerts_tenant_display()
    with get_db_with_sec() as conn:
        sql_tenant_facets = (
            "SELECT DISTINCT "
            + alerts_tenant_disp
            + " AS v "
            + base_from
            + " "
            + where_sql
            + " ORDER BY v COLLATE NOCASE"
        )
        tenants = [r[0] for r in conn.execute(sql_tenant_facets, bind)]
        fw_from = """
            FROM alerts a
            LEFT JOIN firewalls fw ON fw.id = json_extract(a.managed_agent_json, '$')
        """
        sql_host_facets = (
            """
                SELECT DISTINCT COALESCE(NULLIF(fw.hostname, ''), NULLIF(fw.name, ''), '—') AS v
                """
            + fw_from
            + " "
            + where_sql
            + " ORDER BY v COLLATE NOCASE"
        )
        hosts = [r[0] for r in conn.execute(sql_host_facets, bind)]
    return {"tenant_names": tenants, "firewall_hostnames": hosts}


@app.get("/api/alerts")
def api_alerts(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    severity: str | None = Query(
        default=None,
        description="Filter: all (default), high, medium, low",
    ),
    tenant_name: list[str] | None = Query(
        default=None,
        description="Repeat param: filter by tenant display name (OR within list)",
    ),
    firewall_hostname: list[str] | None = Query(
        default=None,
        description="Repeat param: filter by firewall hostname / name label (OR within list)",
    ),
    firewall_id: str | None = Query(
        default=None,
        description="Filter alerts whose managed agent is this firewall id",
    ),
    q: str | None = Query(
        default=None,
        max_length=500,
        description="Case-insensitive search across severity, description, category, id, tenant, firewall, raised time",
    ),
):
    offset = (page - 1) * page_size
    search = str(q).strip() if q else None
    if search == "":
        search = None
    fw_id_f = str(firewall_id).strip() if firewall_id else None
    if fw_id_f == "":
        fw_id_f = None
    where_sql, bind = _alerts_where_sql(
        severity, tenant_name, firewall_hostname, search, fw_id_f
    )
    sql_from = """
        FROM alerts a
        LEFT JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN firewalls fw ON fw.id = json_extract(a.managed_agent_json, '$')
    """
    alerts_tenant_disp = _sql_alerts_tenant_display()
    with get_db_with_sec() as conn:
        total = conn.execute(
            "SELECT COUNT(*) " + sql_from + " " + where_sql,
            bind,
        ).fetchone()[0]
        sql_alerts_page = (
            """
            SELECT
              a.id,
              a.severity,
              a.description,
              a.raised_at,
              a.category,
              """
            + alerts_tenant_disp
            + """ AS tenant_name,
              COALESCE(NULLIF(fw.hostname, ''), NULLIF(fw.name, ''), '—') AS firewall_hostname
            """
            + sql_from
            + " "
            + where_sql
            + """
            ORDER BY datetime(a.raised_at) DESC
            LIMIT ? OFFSET ?
            """
        )
        cur = conn.execute(sql_alerts_page, (*bind, page_size, offset))
        items = [row_to_dict(r) for r in cur.fetchall()]
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/alerts/recent")
def api_alerts_recent(limit: int = Query(default=20, ge=1, le=200)):
    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT severity, product, description, raised_at, category
            FROM alerts
            ORDER BY datetime(raised_at) DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [row_to_dict(r) for r in cur.fetchall()]


@app.get("/api/alerts/{alert_id}")
def api_alert_detail(alert_id: str):
    alerts_tenant_disp = _sql_alerts_tenant_display()
    with get_db_with_sec() as conn:
        sql_alert_one = (
            """
            SELECT
              a.id,
              a.tenant_id,
              a.category,
              a.description,
              a.group_key,
              a.product,
              a.raised_at,
              a.severity,
              a.type,
              a.allowed_actions_json,
              a.managed_agent_json,
              a.person_json,
              a.tenant_ref_json,
              a.first_sync,
              a.last_sync,
              a.sync_id,
              """
            + alerts_tenant_disp
            + """ AS tenant_name
            FROM alerts a
            LEFT JOIN tenants t ON t.id = a.tenant_id
            WHERE a.id = ?
            """
        )
        cur = conn.execute(sql_alert_one, (alert_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Alert not found")
        d = row_to_dict(row)
        fhost, fname = _firewall_hostname_name(conn, d.get("managed_agent_json"))
        d["tenant_display_name"] = d.get("tenant_name")
        d["firewall_hostname"] = fhost
        d["firewall_name"] = fname
        return d


def _verify_central_login(client_id: str, client_secret: str) -> tuple[bool, str | None, dict | None]:
    try:
        session = CentralSession(client_id.strip(), client_secret.strip())
        result = session.authenticate()
    except Exception as e:
        return False, f"Central client error: {e}", None
    if not result.success:
        return False, result.message or "Authentication failed", None
    if session.whoami is None:
        return False, "Whoami response was empty", None
    try:
        return True, None, whoami_dict_from_session(session)
    except Exception as e:
        return False, f"Could not read whoami: {e}", None


class CentralCredentialSecretBody(BaseModel):
    client_id: str = Field(min_length=1, max_length=512)
    client_secret: str = Field(min_length=1, max_length=512)


class CentralCredentialBody(CentralCredentialSecretBody):
    name: str = Field(min_length=1, max_length=200)


class CentralCredentialRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CentralCredentialSyncIntervalBody(BaseModel):
    sync_interval: Literal["hourly", "3h", "6h", "12h", "daily", "none"]


class AppUiSettingsBody(BaseModel):
    """Firewall list recency badges: NEW / UPD windows in hours (defaults 168 and 48)."""

    fw_new_max_age_hours: int = Field(ge=1, le=8760)
    fw_updated_max_age_hours: int = Field(ge=1, le=8760)
    session_idle_timeout_minutes: int = Field(
        ge=0,
        le=525600,
        description="0 disables idle logout; cookie max_age still applies.",
    )


@app.get("/api/settings/ui")
def api_settings_ui_get(_: str = Depends(current_user_id_dep)):
    if not DB_PATH.exists():
        return {
            "fw_new_max_age_hours": 168,
            "fw_updated_max_age_hours": 48,
            "session_idle_timeout_minutes": 60,
        }
    with get_db() as conn:
        ensure_app_ui_schema(conn)
        row = conn.execute(
            "SELECT fw_new_max_age_hours, fw_updated_max_age_hours, session_idle_timeout_minutes "
            "FROM app_ui_settings WHERE id = 1"
        ).fetchone()
    if not row:
        return {
            "fw_new_max_age_hours": 168,
            "fw_updated_max_age_hours": 48,
            "session_idle_timeout_minutes": 60,
        }
    return {
        "fw_new_max_age_hours": int(row["fw_new_max_age_hours"]),
        "fw_updated_max_age_hours": int(row["fw_updated_max_age_hours"]),
        "session_idle_timeout_minutes": int(row["session_idle_timeout_minutes"]),
    }


@app.patch("/api/settings/ui")
def api_settings_ui_patch(
    body: AppUiSettingsBody,
    _: str = Depends(current_user_id_dep),
):
    if not DB_PATH.exists():
        raise HTTPException(status_code=503, detail="Database not available")
    with get_db() as conn:
        ensure_app_ui_schema(conn)
        conn.execute(
            """
            UPDATE app_ui_settings SET
              fw_new_max_age_hours = ?,
              fw_updated_max_age_hours = ?,
              session_idle_timeout_minutes = ?
            WHERE id = 1
            """,
            (
                body.fw_new_max_age_hours,
                body.fw_updated_max_age_hours,
                body.session_idle_timeout_minutes,
            ),
        )
        conn.commit()
    invalidate_session_idle_timeout_cache()
    return {
        "fw_new_max_age_hours": body.fw_new_max_age_hours,
        "fw_updated_max_age_hours": body.fw_updated_max_age_hours,
        "session_idle_timeout_minutes": body.session_idle_timeout_minutes,
    }


@app.get("/api/settings/credentials")
def api_settings_credentials_list(_: str = Depends(admin_user_id_dep)):
    with get_secrets_db() as conn:
        return list_credentials(conn)


@app.post("/api/settings/credentials/test")
def api_settings_credentials_test(
    body: CentralCredentialSecretBody,
    _: str = Depends(admin_user_id_dep),
):
    ok, msg, whoami = _verify_central_login(body.client_id, body.client_secret)
    if not ok:
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    return {"ok": True, "whoami": whoami, "id_type": whoami.get("idType") if whoami else None}


@app.post("/api/settings/credentials")
def api_settings_credentials_create(
    body: CentralCredentialBody,
    _: str = Depends(admin_user_id_dep),
):
    ok, msg, whoami = _verify_central_login(body.client_id, body.client_secret)
    if not ok:
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    if not whoami or not whoami.get("idType"):
        raise HTTPException(status_code=400, detail="Whoami did not return idType")
    with get_secrets_db() as conn:
        row = insert_credential(
            conn,
            name=body.name,
            client_id=body.client_id,
            client_secret=body.client_secret,
            whoami=whoami,
        )
    return row


@app.post("/api/settings/credentials/{cred_id}/test")
def api_settings_credentials_retest_stored(
    cred_id: str,
    _: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        try:
            pair = get_stored_credential_secrets(conn, cred_id)
        except ValueError as e:
            raise HTTPException(
                status_code=500,
                detail=str(e) or "Could not decrypt stored secret",
            ) from e
        if pair is None:
            raise HTTPException(status_code=404, detail="Credential not found")
        client_id, client_secret = pair

    ok, msg, whoami = _verify_central_login(client_id, client_secret)
    if not ok:
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    if not whoami or not whoami.get("idType"):
        raise HTTPException(status_code=400, detail="Whoami did not return idType")

    with get_secrets_db() as conn:
        row = update_credential_whoami(conn, cred_id, whoami)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return {"ok": True, "credential": row}


@app.patch("/api/settings/credentials/{cred_id}")
def api_settings_credentials_rename(
    cred_id: str,
    body: CentralCredentialRenameBody,
    _: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        row = update_credential_name(conn, cred_id, body.name)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return row


@app.get("/api/sync/status")
def api_sync_status(_: str = Depends(current_user_id_dep)):
    activity = get_public_sync_activity()
    with get_secrets_db() as conn:
        ts = max_last_successful_sync_at(conn)
        by_type = count_credentials_by_id_type(conn)
        creds = list_credentials(conn)
    return {
        "last_successful_data_sync": ts,
        "credential_counts_by_id_type": by_type,
        "sync_interval_summary": credentials_interval_summary(creds),
        "sync_busy": activity["busy"],
        "sync_credential_name": activity["credential_name"],
        "sync_credential_id": activity["credential_id"],
        "sync_trigger": activity["trigger"],
    }


@app.patch("/api/settings/credentials/{cred_id}/sync-interval")
def api_settings_credentials_sync_interval(
    cred_id: str,
    body: CentralCredentialSyncIntervalBody,
    _: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        row = update_credential_sync_interval(conn, cred_id, body.sync_interval)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return row


@app.post("/api/settings/credentials/{cred_id}/sync-now")
def api_settings_credentials_sync_now(
    cred_id: str,
    _: str = Depends(admin_user_id_dep),
):
    """Run central library sync into sophos_central.db, then refresh stored whoami for the UI."""
    with get_db() as central_conn:
        result = run_credential_sync(cred_id, central_conn=central_conn, trigger="manual")
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error or "Sync failed")
    cred = result.credential
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return {
        "ok": True,
        "credential": cred,
        "sync_id": result.sync_id,
        "summary": result.summary,
    }


@app.delete("/api/settings/credentials/{cred_id}")
def api_settings_credentials_delete(
    cred_id: str,
    _: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        ok = delete_credential(conn, cred_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Credential not found")
    return {"ok": True}


@app.get("/api/license-subscriptions")
def api_license_subscriptions(
    serial: str | None = Query(default=None, description="Filter by license serial"),
):
    sql = """
        SELECT
          id,
          serial_number,
          license_identifier,
          product_code,
          product_name,
          start_date,
          end_date,
          perpetual,
          type,
          quantity,
          usage_count,
          unlimited
        FROM license_subscriptions
    """
    args: tuple = ()
    if serial:
        sql += " WHERE serial_number = ?"
        args = (serial,)
    sql += " ORDER BY (product_name IS NULL), product_name COLLATE NOCASE, id"
    with get_db() as conn:
        cur = conn.execute(sql, args)
        return [row_to_dict(r) for r in cur.fetchall()]


def main():
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8765,
        reload=True,
    )


if __name__ == "__main__":
    main()
