"""SFOS Central Firewall Management: web UI backed by sophos_central.db."""

from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import signal
import sqlite3
import tomllib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlencode, urljoin

import requests
from contextlib import asynccontextmanager, contextmanager
import sys
from pathlib import Path

from app_paths import bundle_root, runtime_root
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
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
from central.firewalls.groups.methods import create_firewall_group, delete_firewall_group
from central.session import CentralSession
from credential_store import (
    DEFAULT_ADMIN_USERNAME,
    SECRETS_DB_PATH,
    bootstrap_setup_target_user_id,
    count_admins,
    credential_name_for_synced_tenant,
    credential_name_for_tenant_client_id,
    delete_app_user,
    delete_credential,
    ensure_default_admin_user,
    get_app_user_by_id,
    get_app_user_by_username,
    get_secrets_db,
    get_credential_id_by_client_id,
    get_credential_id_tenant_scoped_for_central_tenant,
    get_stored_credential_secrets,
    get_stored_credential_secrets_by_client_id,
    get_user_operations_ui_json,
    insert_app_user,
    insert_credential,
    list_app_users,
    count_credentials_by_id_type,
    credentials_interval_summary,
    list_credentials,
    max_last_successful_data_sync_at,
    needs_initial_admin_password,
    update_app_user_password_hash,
    update_app_user_profile_cols,
    update_app_user_role,
    user_row_public,
    update_credential_name,
    update_credential_incremental_sync_interval,
    update_credential_sync_interval,
    set_user_operations_ui_json,
    update_credential_whoami,
    whoami_dict_from_session,
)
from audit_log import audit_event, mask_oauth_client_id
from git_auto_update import (
    GIT_AUTO_UPDATE_INTERVAL_CHOICES,
    git_repo_root,
    git_update_page_visible,
    normalize_git_auto_update_interval,
    start_git_update_scheduler_thread,
)
from sync_runner import configure_sync_file_logging, get_public_sync_activity, run_credential_sync
from sync_scheduler import start_scheduler_thread

DB_PATH = runtime_root() / "sophos_central.db"

# Shown in /api/firewall-groups when config import references a firewall not present locally.
IMPORTED_FROM_FIREWALL_REMOVED_LABEL = "<Removed>"

# Display name and defaults for Settings → About (version/license from pyproject.toml when present).
_APP_DISPLAY_NAME = "SFOS Central Firewall Management"
_APP_VERSION_FALLBACK = "0.1.0"
_APP_LICENSE_FALLBACK = "See the project repository for licensing information."


def load_app_about() -> dict[str, str]:
    """Name, version, license, and pyproject metadata for the About panel."""
    version = _APP_VERSION_FALLBACK
    license_line = _APP_LICENSE_FALLBACK
    project_name = ""
    description = ""
    path = bundle_root() / "pyproject.toml"
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
        proj = data.get("project") or {}
        pn = proj.get("name")
        if pn:
            project_name = str(pn).strip()
        desc = proj.get("description")
        if desc:
            description = str(desc).strip()
        v = proj.get("version")
        if v:
            version = str(v).strip()
        lic = proj.get("license")
        if isinstance(lic, dict):
            text = lic.get("text")
            if text:
                license_line = str(text).strip()
            elif lic.get("file"):
                license_line = f"License file: {lic['file']}"
        elif isinstance(lic, str) and lic.strip():
            license_line = lic.strip()
    except OSError:
        pass
    return {
        "app_name": _APP_DISPLAY_NAME,
        "project_name": project_name,
        "description": description,
        "app_version": version,
        "license": license_line,
    }


APP_ABOUT = load_app_about()


def _actor_for_audit(user_id: str | None) -> tuple[str | None, str | None]:
    if not user_id:
        return None, None
    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, user_id)
    if not row:
        return user_id, None
    un = str(row["username"] or "").strip()
    return user_id, un or None


def _audit_err(msg: str | None) -> str | None:
    if not msg:
        return None
    s = str(msg).strip()
    if len(s) > 240:
        return s[:240] + "…"
    return s
TEMPLATES = bundle_root() / "templates"
STATIC = bundle_root() / "static"

jinja = Environment(
    loader=FileSystemLoader(str(TEMPLATES)),
    autoescape=select_autoescape(["html", "xml"]),
)


@contextmanager
def get_db():
    """Writable connection for sync and mutating API handlers."""
    conn = sqlite3.connect(DB_PATH, timeout=60.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout=60000")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def get_db_readonly():
    """
    Read-only URI connection for list/detail API queries.

    Avoids competing with the Central sync job for the main database writer lock
    (long SDK transactions commit only at end of sync). WAL still lets readers
    see the last committed snapshot while sync runs.
    """
    uri = DB_PATH.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=60.0)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA busy_timeout=60000")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("PRAGMA query_only=ON")
    except sqlite3.OperationalError:
        pass
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
    if "git_auto_update_interval" not in cols:
        conn.execute(
            "ALTER TABLE app_ui_settings ADD COLUMN git_auto_update_interval "
            "TEXT NOT NULL DEFAULT '1h'"
        )
    if "git_auto_update_last_check_at" not in cols:
        conn.execute(
            "ALTER TABLE app_ui_settings ADD COLUMN git_auto_update_last_check_at TEXT"
        )
    if "git_auto_update_last_message" not in cols:
        conn.execute(
            "ALTER TABLE app_ui_settings ADD COLUMN git_auto_update_last_message TEXT"
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


@contextmanager
def get_db_with_sec_readonly():
    """Like ``get_db_with_sec`` but read-only on both DBs (UI reads during background sync)."""
    with get_db_readonly() as conn:
        sec_uri = SECRETS_DB_PATH.resolve().as_uri() + "?mode=ro"
        conn.execute("ATTACH DATABASE ? AS sec", (sec_uri,))
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


def _parse_alert_allowed_actions_json(raw: object) -> list[str]:
    """Parse ``alerts.allowed_actions_json`` (Sophos ``allowedActions`` array) to strings."""
    if raw is None:
        return []
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for x in data:
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
    return out


def _alert_allowed_actions_include_acknowledge(actions: list[str]) -> bool:
    return any(a.casefold() == "acknowledge" for a in actions)


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


def _firewall_ids_assigned_in_any_group_for_tenant(
    conn: sqlite3.Connection, tenant_id: str
) -> set[str]:
    tid = str(tenant_id or "").strip()
    if not tid:
        return set()
    cur = conn.execute(
        "SELECT firewalls_items_json FROM firewall_groups WHERE tenant_id = ?",
        (tid,),
    )
    out: set[str] = set()
    for r in cur.fetchall():
        for fid in _parse_firewall_group_items_json(r["firewalls_items_json"]):
            out.add(fid)
    return out


def _capabilities_include_config_import(raw: str | None) -> bool:
    if raw is None or str(raw).strip() == "":
        return False
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(data, list):
        return False
    return any(x == "configImport" for x in data if isinstance(x, str))


def _oauth_client_for_tenant_firewall_api(
    conn: sqlite3.Connection, tenant_id: str
) -> tuple[str, str, str | None]:
    tid = str(tenant_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    row = conn.execute(
        """
        SELECT client_id FROM firewalls
        WHERE tenant_id = ? AND TRIM(COALESCE(client_id, '')) != ''
        LIMIT 1
        """,
        (tid,),
    ).fetchone()
    if not row:
        raise HTTPException(
            status_code=503,
            detail="No synced firewall OAuth client for this tenant; run a Central sync first.",
        )
    cid = str(row["client_id"]).strip()
    with get_secrets_db() as sconn:
        pair = get_stored_credential_secrets_by_client_id(sconn, cid)
        cred_row_id = get_credential_id_by_client_id(sconn, cid)
    if not pair:
        raise HTTPException(
            status_code=503,
            detail="No stored Central credential matches this tenant's API client id.",
        )
    return pair[0], pair[1], cred_row_id


def _firewall_row_for_group_create_ui(d: dict) -> dict:
    connected = d.get("connected")
    suspended = d.get("suspended")
    return {
        "id": d.get("id"),
        "hostname": (d.get("hostname") or "").strip() or None,
        "name": (d.get("name") or "").strip() or None,
        "managing_status": d.get("managing_status") or "",
        "reporting_status": d.get("reporting_status") or "",
        "connected": 1 if connected in (1, True, "1") else 0,
        "suspended": 1 if suspended in (1, True, "1") else 0,
    }


def _json_object_maybe(raw: str | None) -> dict | None:
    if raw is None or str(raw).strip() == "":
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _firewall_id_from_config_import_value(v: object) -> str | None:
    """Central may return a UUID string or a dict (e.g. ``sourceFirewall`` with ``id``)."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s or None
    if isinstance(v, dict):
        for inner in ("id", "firewallId", "firewall_id"):
            x = v.get(inner)
            if x is None:
                continue
            s = str(x).strip()
            if s:
                return s
        return None
    s = str(v).strip()
    return s or None


def _source_firewall_id_from_config_import(obj: dict | None) -> str | None:
    if not obj:
        return None
    for key in (
        "sourcefirewall",
        "sourceFirewall",
        "source_firewall",
        "sourceFirewallId",
        "firewallId",
        "firewall_id",
    ):
        v = obj.get(key)
        fid = _firewall_id_from_config_import_value(v)
        if fid:
            return fid
    return None


def _firewall_id_display_map(conn: sqlite3.Connection) -> dict[str, str]:
    """Firewall id → best display label (hostname, name, or serial)."""
    cur = conn.execute(
        """
        SELECT id,
               CASE
                 WHEN TRIM(COALESCE(hostname, '')) != '' THEN TRIM(hostname)
                 WHEN TRIM(COALESCE(name, '')) != '' THEN TRIM(name)
                 WHEN TRIM(COALESCE(serial_number, '')) != '' THEN TRIM(serial_number)
                 ELSE ''
               END AS label
        FROM firewalls
        """
    )
    out: dict[str, str] = {}
    for r in cur.fetchall():
        d = row_to_dict(r)
        fid = str(d.get("id") or "").strip()
        if not fid:
            continue
        lab = str(d.get("label") or "").strip()
        if lab:
            out[fid] = lab
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


GEOIP_USER_AGENT = "SophosCentralGUI/0.1 (approximate map position from public IPv4; ipwho.is)"


def _geoip_lookup_ipv4(ip_s: str) -> tuple[float, float] | None:
    """Return approximate (latitude, longitude) for a public IPv4 via ipwho.is (HTTPS)."""
    ip_s = (ip_s or "").strip()
    if not ip_s:
        return None
    try:
        addr = ipaddress.ip_address(ip_s)
    except ValueError:
        return None
    if addr.version != 4:
        return None
    try:
        resp = requests.get(
            f"https://ipwho.is/{ip_s}",
            headers={"User-Agent": GEOIP_USER_AGENT},
            timeout=12,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get("success"):
        return None
    lat_raw = data.get("latitude")
    lon_raw = data.get("longitude")
    try:
        lat = float(lat_raw)  # type: ignore[arg-type]
        lon = float(lon_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        return None
    return lat, lon


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


def _parse_iso_occurred_at(val: str | None) -> datetime | None:
    if val is None or not str(val).strip():
        return None
    s = str(val).strip().replace(" ", "T", 1)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _dt_iso_z(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    return utc.isoformat().replace("+00:00", "Z")


def _connected_cell_to_bool(val: str | None) -> bool | None:
    if val is None:
        return None
    s = str(val).strip().lower()
    if s in ("1", "true", "yes"):
        return True
    if s in ("0", "false", "no", ""):
        return False
    try:
        return int(s) != 0
    except ValueError:
        return None


def _connected_from_firewall_insert_payload(raw: str | None) -> bool | None:
    if not raw or not str(raw).strip():
        return None
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(d, dict):
        return None
    if "connected" not in d:
        return None
    return _connected_cell_to_bool(str(d.get("connected")))


def _sync_change_events_table_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        ("sync_change_events",),
    ).fetchone()
    return row is not None


def _state_before_sync_change_row(row: sqlite3.Row) -> bool | None:
    if row["operation"] == "update" and row["column_name"] == "connected":
        return _connected_cell_to_bool(row["old_value"])
    return None


def _firewall_connectivity_history_payload(
    conn: sqlite3.Connection,
    *,
    firewall_id: str,
    days: int,
) -> dict:
    """Build 30-day (default) connectivity segments from ``sync_change_events``."""
    days_capped = max(1, min(int(days), 90))
    window_end = datetime.now(timezone.utc)
    window_start = window_end - timedelta(days=days_capped)
    if not _sync_change_events_table_exists(conn):
        return {
            "window_start": _dt_iso_z(window_start),
            "window_end": _dt_iso_z(window_end),
            "days": days_capped,
            "segments": [],
            "event_count": 0,
        }

    cur = conn.execute(
        """
        SELECT id, occurred_at, operation, column_name, old_value, new_value
        FROM sync_change_events
        WHERE table_name = 'firewalls'
          AND json_valid(row_key_json)
          AND json_extract(row_key_json, '$.id') = ?
          AND (
            operation = 'insert'
            OR (operation = 'update' AND column_name = 'connected')
          )
        ORDER BY occurred_at ASC, id ASC
        """,
        (firewall_id,),
    )
    rows = cur.fetchall()
    timeline: list[tuple[datetime, bool | None, sqlite3.Row]] = []
    for row in rows:
        dt = _parse_iso_occurred_at(row["occurred_at"])
        if dt is None:
            continue
        op = row["operation"]
        if op == "insert":
            c_after = _connected_from_firewall_insert_payload(row["new_value"])
            timeline.append((dt, c_after, row))
        elif op == "update" and row["column_name"] == "connected":
            c_new = _connected_cell_to_bool(row["new_value"])
            if c_new is None:
                continue
            timeline.append((dt, c_new, row))

    segments: list[dict[str, str | bool | None]] = []
    if not timeline:
        return {
            "window_start": _dt_iso_z(window_start),
            "window_end": _dt_iso_z(window_end),
            "days": days_capped,
            "segments": [],
            "event_count": len(rows),
        }

    # State holds through the end of the window unless trimmed by events.
    state: bool | None = None
    ti = 0
    while ti < len(timeline) and timeline[ti][0] < window_start:
        state = timeline[ti][1]
        ti += 1

    if ti < len(timeline) and ti == 0 and timeline[ti][0] > window_start:
        state = _state_before_sync_change_row(timeline[ti][2])

    prev = window_start
    cur_state = state
    while ti < len(timeline):
        t, next_state, _ = timeline[ti]
        if t >= window_end:
            break
        if t > prev:
            seg_until = min(t, window_end)
            segments.append(
                {
                    "start": _dt_iso_z(prev),
                    "end": _dt_iso_z(seg_until),
                    "connected": cur_state,
                }
            )
            prev = seg_until
        cur_state = next_state
        ti += 1
    if prev < window_end:
        segments.append(
            {
                "start": _dt_iso_z(prev),
                "end": _dt_iso_z(window_end),
                "connected": cur_state,
            }
        )

    return {
        "window_start": _dt_iso_z(window_start),
        "window_end": _dt_iso_z(window_end),
        "days": days_capped,
        "segments": segments,
        "event_count": len(rows),
    }


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
    start_git_update_scheduler_thread()
    yield


app = FastAPI(
    title=APP_ABOUT["app_name"],
    version=APP_ABOUT["app_version"],
    lifespan=lifespan,
)

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
            row = None
            try:
                with get_db_readonly() as conn:
                    row = conn.execute(
                        "SELECT session_idle_timeout_minutes FROM app_ui_settings WHERE id = 1"
                    ).fetchone()
            except sqlite3.OperationalError:
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
        idle_state, expired_uid = evaluate_session_idle(request, idle_sec)
        if idle_state == "expired":
            u_exp, n_exp = _actor_for_audit(expired_uid)
            audit_event(
                action="session.idle_timeout",
                actor_user_id=u_exp,
                actor_username=n_exp,
                request=request,
            )
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


def _graceful_shutdown() -> None:
    """Stop the uvicorn process after the HTTP response has been sent."""
    import time

    time.sleep(0.08)
    pid = os.getpid()
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        try:
            signal.raise_signal(signal.SIGINT)
        except (OSError, RuntimeError, ValueError):
            os._exit(0)


@app.post("/api/admin/shutdown")
def api_admin_shutdown(
    request: Request,
    background: BackgroundTasks,
    admin_uid: str = Depends(admin_user_id_dep),
):
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="app.shutdown_requested",
        actor_user_id=au,
        actor_username=an,
        request=request,
    )
    background.add_task(_graceful_shutdown)
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index():
    tpl = jinja.get_template("index.html")
    return HTMLResponse(
        tpl.render(
            app_about=APP_ABOUT,
            git_update_available=git_update_page_visible(),
        )
    )


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
            idle_state, _ = evaluate_session_idle(request, idle_sec)
            if idle_state == "expired":
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
    uname_attempt = body.username.strip()
    if not row or not verify_password(body.password, row["password_hash"]):
        audit_event(
            action="auth.login",
            outcome="failure",
            actor_username=uname_attempt,
            request=request,
            detail={"reason": "invalid_credentials"},
        )
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    request.session[SESSION_USER_ID_KEY] = row["id"]
    touch_session_activity(request)
    with get_secrets_db() as conn:
        row2 = get_app_user_by_id(conn, row["id"])
    au, an = _actor_for_audit(row["id"])
    audit_event(
        action="auth.login",
        actor_user_id=au,
        actor_username=an,
        request=request,
    )
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
    au, an = _actor_for_audit(uid)
    audit_event(
        action="user.initial_admin_password_set",
        actor_user_id=au,
        actor_username=an,
        request=request,
    )
    return {"ok": True, "user": user_row_public(row2) if row2 else None}


@app.post("/api/auth/activity")
def api_auth_activity():
    """No-op; session idle is refreshed by ProtectApiMiddleware before this runs."""
    return {"ok": True}


@app.post("/api/auth/logout")
def api_auth_logout(request: Request):
    uid = session_user_id(request)
    au, an = _actor_for_audit(uid)
    request.session.clear()
    audit_event(
        action="auth.logout",
        actor_user_id=au,
        actor_username=an,
        request=request,
    )
    return {"ok": True}


@app.get("/api/auth/me")
def api_auth_me(request: Request, _uid: str = Depends(current_user_id_dep)):
    with get_secrets_db() as conn:
        row = get_app_user_by_id(conn, _uid)
    if not row:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Session is no longer valid.")
    return {"user": user_row_public(row)}


_OPS_UI_JSON_MAX_BYTES = 200_000


@app.get("/api/me/operations-ui")
def api_me_operations_ui_get(uid: str = Depends(current_user_id_dep)):
    with get_secrets_db() as conn:
        raw = get_user_operations_ui_json(conn, uid)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


@app.patch("/api/me/operations-ui")
async def api_me_operations_ui_patch(request: Request, uid: str = Depends(current_user_id_dep)):
    body = await request.body()
    if len(body) > _OPS_UI_JSON_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Payload too large")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail="Invalid JSON") from e
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    serialized = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    if len(serialized.encode("utf-8")) > _OPS_UI_JSON_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Payload too large")
    with get_secrets_db() as conn:
        if not set_user_operations_ui_json(conn, uid, serialized):
            request.session.clear()
            raise HTTPException(status_code=401, detail="Session is no longer valid.")
    return data


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
    au, an = _actor_for_audit(uid)
    audit_event(
        action="user.profile_self_update",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"fields": sorted(updates.keys())},
    )
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
    au, an = _actor_for_audit(uid)
    audit_event(
        action="user.password_change_self",
        actor_user_id=au,
        actor_username=an,
        request=request,
    )
    return {"ok": True}


@app.get("/api/settings/users")
def api_settings_users_list(_: str = Depends(current_user_id_dep)):
    with get_secrets_db() as conn:
        return list_app_users(conn)


@app.post("/api/settings/users")
def api_settings_users_create(
    request: Request,
    body: CreateAppUserBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    validate_new_password(body.password)
    uname = body.username.strip()
    with get_secrets_db() as conn:
        if get_app_user_by_username(conn, uname):
            raise HTTPException(status_code=400, detail="That username is already taken.")
        ph = hash_password(body.password)
        created = insert_app_user(
            conn,
            username=uname,
            role=body.role,
            password_hash=ph,
            full_name=body.full_name,
            email=body.email,
            mobile=body.mobile,
        )
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="user.create",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "new_user_id": created.get("id"),
            "new_username": uname,
            "new_user_role": body.role,
        },
    )
    return created


@app.patch("/api/settings/users/{user_id}")
def api_settings_users_patch(
    request: Request,
    user_id: str,
    body: PatchAppUserBody,
    admin_uid: str = Depends(admin_user_id_dep),
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
    au, an = _actor_for_audit(admin_uid)
    adetail: dict = {"target_user_id": user_id}
    if body.role is not None:
        adetail["role"] = body.role
    if body.password is not None:
        adetail["password_reset"] = True
    if profile_updates:
        adetail["profile_fields"] = sorted(profile_updates.keys())
    audit_event(
        action="user.update_by_admin",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail=adetail,
    )
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
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="user.delete",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "deleted_user_id": user_id,
            "deleted_username": str(row["username"] or "").strip() or None,
        },
    )
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


def _alerts_severity_where_multi(severities: list[str] | None) -> tuple[str, tuple]:
    """OR of high / medium / low fragments; empty if none or all three selected."""
    if not severities:
        return "", ()
    levels: list[str] = []
    for raw in severities:
        s = str(raw).lower().strip()
        if s in ("high", "medium", "low") and s not in levels:
            levels.append(s)
    if not levels or len(levels) >= 3:
        return "", ()
    parts: list[str] = []
    args: list = []
    for s in levels:
        frag, extra = _alerts_severity_where(s)
        if frag:
            parts.append("(" + frag + ")")
        args.extend(extra)
    if not parts:
        return "", ()
    return "(" + " OR ".join(parts) + ")", tuple(args)


def _parse_alert_raised_iso_to_sqlite(s: str) -> str | None:
    """Parse ISO-8601 (with Z or offset) to naive UTC ``YYYY-MM-DD HH:MM:SS`` for SQLite."""
    t = str(s).strip()
    if not t:
        return None
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _alerts_raised_where(raised_from: str | None, raised_to: str | None) -> tuple[str, tuple]:
    """Filter ``a.raised_at`` to an inclusive UTC range; empty if both params omitted."""
    rf_raw = str(raised_from).strip() if raised_from else ""
    rt_raw = str(raised_to).strip() if raised_to else ""
    if not rf_raw and not rt_raw:
        return "", ()
    default_from = "2000-01-01T00:00:00Z"
    default_to = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rf_parsed = _parse_alert_raised_iso_to_sqlite(rf_raw) if rf_raw else _parse_alert_raised_iso_to_sqlite(default_from)
    rt_parsed = _parse_alert_raised_iso_to_sqlite(rt_raw) if rt_raw else _parse_alert_raised_iso_to_sqlite(default_to)
    if rf_parsed is None or rt_parsed is None:
        return "", ()
    if rf_parsed > rt_parsed:
        rf_parsed, rt_parsed = rt_parsed, rf_parsed
    frag = "(datetime(a.raised_at) >= datetime(?) AND datetime(a.raised_at) <= datetime(?))"
    return frag, (rf_parsed, rt_parsed)


def _alerts_search_like_pattern(raw: str) -> str:
    """Lowercased LIKE pattern with %wildcards%; escape % _ \\ for use with ESCAPE '\\'."""
    s = str(raw).strip().lower()
    s = s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{s}%"


def _alerts_where_sql(
    severities: list[str] | None,
    tenant_names: list[str] | None,
    firewall_hostnames: list[str] | None,
    search: str | None = None,
    firewall_id: str | None = None,
    raised_from: str | None = None,
    raised_to: str | None = None,
) -> tuple[str, tuple]:
    """Full WHERE clause (including WHERE keyword) and bind values for alert list/count."""
    conditions: list[str] = []
    bind: list = []

    frag, extra = _alerts_severity_where_multi(severities)
    if frag:
        conditions.append("(" + frag + ")")
    bind.extend(extra)

    rf_frag, rf_bind = _alerts_raised_where(raised_from, raised_to)
    if rf_frag:
        conditions.append(rf_frag)
    bind.extend(rf_bind)

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


def _parse_sync_timestamp_ms(val: object) -> float | None:
    """Parse API/SQLite timestamp strings to epoch milliseconds (naive → UTC)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000.0
    except ValueError:
        return None


def _fw_recency_hours_from_db(conn: sqlite3.Connection) -> tuple[int, int]:
    """Read recency windows; no schema writes (safe for read-only UI connections)."""
    try:
        row = conn.execute(
            "SELECT fw_new_max_age_hours, fw_updated_max_age_hours FROM app_ui_settings WHERE id = 1"
        ).fetchone()
    except sqlite3.OperationalError:
        return 168, 48
    if not row:
        return 168, 48
    return int(row["fw_new_max_age_hours"]), int(row["fw_updated_max_age_hours"])


def _attach_alert_recency_tags(
    items: list[dict],
    conn: sqlite3.Connection,
    sql_from: str,
    where_sql: str,
    bind: tuple,
) -> None:
    """Set ``recency_tag`` on each alert (``new`` / ``old`` / ``upd`` / omitted).

    NEW uses ``raised_at`` within the configured new row window. OLD / UPD still use ``last_sync``
    (peer comparison on ``client_id`` vs max ``last_sync``, then recent ``last_sync``).
    """
    if not items:
        return
    new_h, upd_h = _fw_recency_hours_from_db(conn)
    new_ms = new_h * 3600000.0
    upd_ms = upd_h * 3600000.0
    now_ms = datetime.now(timezone.utc).timestamp() * 1000.0

    agg_sel = (
        "SELECT TRIM(COALESCE(a.client_id, '')) AS cid, COUNT(*) AS cnt, MAX(a.last_sync) AS mx_ls "
        + sql_from
        + " "
    )
    if where_sql:
        agg_sel += where_sql + " AND a.client_id IS NOT NULL AND TRIM(a.client_id) != '' "
    else:
        agg_sel += "WHERE a.client_id IS NOT NULL AND TRIM(a.client_id) != '' "
    agg_sel += "GROUP BY cid"

    max_sync_by_client: dict[str, float] = {}
    for r in conn.execute(agg_sel, bind):
        d = row_to_dict(r)
        cid = str(d.get("cid") or "").strip()
        if not cid:
            continue
        try:
            cnt = int(d.get("cnt") or 0)
        except (TypeError, ValueError):
            cnt = 0
        mx_ms = _parse_sync_timestamp_ms(d.get("mx_ls"))
        if cnt >= 2 and mx_ms is not None:
            max_sync_by_client[cid] = mx_ms

    for it in items:
        it["recency_tag"] = None
        raised_ms = _parse_sync_timestamp_ms(it.get("raised_at"))
        last_ms = _parse_sync_timestamp_ms(it.get("last_sync"))
        is_new = raised_ms is not None and now_ms - raised_ms <= new_ms
        if is_new:
            it["recency_tag"] = "new"
            continue
        cid = str(it.get("client_id") or "").strip()
        is_old = False
        if cid and cid in max_sync_by_client:
            max_t = max_sync_by_client[cid]
            my_t = last_ms
            if my_t is None or my_t < max_t:
                is_old = True
        if is_old:
            it["recency_tag"] = "old"
            continue
        if last_ms is not None and now_ms - last_ms <= upd_ms:
            it["recency_tag"] = "upd"


@app.get("/api/dashboard")
def api_dashboard():
    with get_db_readonly() as conn:
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
    with get_db_with_sec_readonly() as conn:
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


@app.get("/api/firewalls/{firewall_id}/connectivity-history")
def api_firewall_connectivity_history(
    firewall_id: str,
    days: int = Query(default=30, ge=1, le=90),
    _: str = Depends(current_user_id_dep),
):
    """Per-firewall connected/up segments from ``sync_change_events`` (insert + ``connected`` updates)."""
    with get_db_readonly() as conn:
        row = conn.execute("SELECT id FROM firewalls WHERE id = ?", (firewall_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Firewall not found")
        return _firewall_connectivity_history_payload(conn, firewall_id=firewall_id, days=days)


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
    request: Request,
    body: FirewallApproveBatchBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    """Approve selected firewalls via Central API, then sync each credential that had a success."""
    ids = [str(x).strip() for x in body.firewall_ids if x is not None and str(x).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="firewall_ids must not be empty.")
    au_adm, an_adm = _actor_for_audit(admin_uid)
    approved: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = []
    sync_cred_ids: set[str] = set()

    with get_db_readonly() as conn:
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

            audit_event(
                action="central.firewall_approve_management",
                actor_user_id=au_adm,
                actor_username=an_adm,
                request=request,
                detail={
                    "firewall_id": fw_id,
                    "tenant_id": fw_tenant_id,
                    "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
                },
            )
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
    request: Request,
    body: FirewallFirmwareUpgradeBatchBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    """Schedule or run firmware upgrades on Central for selected firewalls (grouped by OAuth client + tenant)."""
    scheduled_utc = _parse_scheduled_at_iso_to_utc(body.scheduled_at)
    upgrade_at_str = _upgrade_at_string_for_central_api(scheduled_utc)

    au_adm, an_adm = _actor_for_audit(admin_uid)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    skipped: list[dict] = []
    errors: list[dict] = []

    with get_db_readonly() as conn:
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
        audit_event(
            action="central.firewall_firmware_upgrade",
            actor_user_id=au_adm,
            actor_username=an_adm,
            request=request,
            detail={
                "tenant_id": fw_tenant_id,
                "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
                "firewall_count": len(upgrade_dicts),
                "scheduled": upgrade_at_str is not None,
                "http_status": cresp.status_code,
            },
        )

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


@app.get("/api/geoip")
def api_geoip(
    ip: str = Query(default="", min_length=1, max_length=45),
    _: str = Depends(current_user_id_dep),
):
    """Approximate latitude/longitude for a public IPv4 (for map hints when DB geo is unset)."""
    pair = _geoip_lookup_ipv4(ip)
    if not pair:
        raise HTTPException(
            status_code=404,
            detail="Could not resolve a location for that IP address.",
        )
    lat, lon = pair
    return {"ok": True, "latitude": lat, "longitude": lon}


class FirewallLocationBody(BaseModel):
    """Set firewall map coordinates. Send either a street address (geocoded) or lat/lon."""

    address: str | None = Field(default=None, max_length=500)
    latitude: float | None = None
    longitude: float | None = None


class FirewallLabelBody(BaseModel):
    """Display name / label for the firewall (PATCHed to Sophos Central as ``name``)."""

    name: str = Field(max_length=256)


def _normalize_sophos_api_base(url: str | None) -> str:
    """Strip whitespace and trailing slashes from Central API base URLs (tenant ``apiHost`` / whoami)."""
    s = str(url or "").strip()
    return s.rstrip("/") if s else s


def _effective_ack_tenant_id(tenant_id_col: str | None, tenant_ref_json: str | None) -> str:
    """
    Tenant UUID for Common API calls: prefer ``tenant.id`` from the synced alert payload when present,
    else the ``alerts.tenant_id`` column.
    """
    if tenant_ref_json:
        try:
            ref = json.loads(tenant_ref_json)
            if isinstance(ref, dict):
                rid = str(ref.get("id") or "").strip()
                if rid:
                    return rid
        except (json.JSONDecodeError, TypeError):
            pass
    return str(tenant_id_col or "").strip()


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
        base = _normalize_sophos_api_base(url_base or session.whoami.data_region_url())
    else:
        base = _normalize_sophos_api_base(url_base or session.whoami.global_url())
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
        errs = data.get("errors")
        if isinstance(errs, list) and errs:
            parts: list[str] = []
            for e in errs[:8]:
                if isinstance(e, dict):
                    code = e.get("code") or e.get("errorCode") or e.get("type")
                    msg = e.get("message") or e.get("detail") or e.get("reason")
                    cs = str(code).strip() if code is not None else ""
                    ms = str(msg).strip() if msg is not None else ""
                    if cs and ms:
                        parts.append(f"{cs}: {ms}")
                    elif ms:
                        parts.append(ms)
                    elif cs:
                        parts.append(cs)
                elif isinstance(e, str) and e.strip():
                    parts.append(e.strip())
            if parts:
                return "; ".join(parts)
    if cresp.error_message and str(cresp.error_message).strip():
        return str(cresp.error_message).strip()
    return f"Sophos Central API error (HTTP {cresp.status_code})"


def _fw_status_pending_approval(managing: str | None, reporting: str | None) -> bool:
    def one(val: str | None) -> bool:
        s = (val or "").strip().lower()
        return s in ("approvalpending", "pendingapproval")

    return one(managing) or one(reporting)


def _post_common_alert_action_on_central(
    *,
    session: CentralSession,
    url_base: str,
    tenant_hdr: str | None,
    org_hdr: str | None,
    alert_id: str,
    action: str,
) -> None:
    """
    POST ``/common/v1/alerts/{id}/actions``.

    Per Common API docs this route requires ``X-Tenant-ID``; ``get_alerts`` / ``take_alert_action``
    in the SDK do not send ``X-Partner-ID``. Match that behavior here (partner/org context is
    implied by the regional base URL + tenant / org headers).
    """
    aid = str(alert_id or "").strip()
    if not aid:
        raise HTTPException(status_code=400, detail="Alert id is empty.")
    rs = session.post(
        f"/common/v1/alerts/{aid}/actions",
        payload={"action": action},
        url_base=url_base,
        tenant_id=tenant_hdr,
        organization_id=org_hdr,
    )
    if rs.success:
        return
    cr = rs.value
    if isinstance(cr, CentralResponse):
        msg = _central_api_error_message(cr)
        if cr.status_code == 404:
            msg = (
                f"{msg} If the alert was already cleared in Sophos Central, run a sync to refresh "
                "local data."
            )
        raise HTTPException(status_code=502, detail=msg)
    msg = getattr(cr, "error_message", None) if cr is not None else None
    raise HTTPException(
        status_code=502,
        detail=msg if msg and str(msg).strip() else "Sophos Central alert action failed.",
    )


def _central_firewall_api_context(
    *,
    oauth_client_id: str,
    oauth_client_secret: str,
    tenant_id: str,
    unsupported_phrase: str = "this action",
) -> tuple[CentralSession, str, str | None, str | None, str | None]:
    """Authenticate and resolve data-region URL + tenant/org/partner headers for firewall APIs.

    For **Firewall v1** (``/firewall/v1/...``), partner credentials must use ``X-Tenant-ID``
    and the tenant's regional ``apiHost`` only. Do not send ``X-Partner-ID`` on those
    requests — Sophos returns HTTP 401 ``BadServerResponse`` when it is set (the SDK's
    ``get_firewalls`` only passes ``tenant_id``). The returned ``partner_hdr`` is for
    callers that need the partner id for other purposes; Common API routes may still
    require org/partner headers (see ``_post_common_alert_action_on_central``).
    """
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
    partner_hdr: str | None = None

    if id_type == "tenant":
        if tenant_id != w.id:
            raise HTTPException(
                status_code=400,
                detail="This firewall belongs to a different tenant than the stored API credential.",
            )
        url_base = _normalize_sophos_api_base(w.data_region_url())
        tenant_hdr = w.id
    elif id_type == "partner":
        partner_hdr = w.id
        tenant_hdr = tenant_id
        with get_db_readonly() as conn:
            trow = conn.execute(
                "SELECT api_host FROM tenants WHERE id = ?",
                (tenant_id,),
            ).fetchone()
        if not trow or not str(trow["api_host"] or "").strip():
            raise HTTPException(
                status_code=503,
                detail="Tenant API host is missing from the local database; sync this tenant from a partner credential first.",
            )
        url_base = _normalize_sophos_api_base(str(trow["api_host"]).strip())
    elif id_type == "organization":
        tenant_hdr = tenant_id
        org_hdr = w.id
        with get_db_readonly() as conn:
            trow = conn.execute(
                "SELECT api_host FROM tenants WHERE id = ?",
                (tenant_id,),
            ).fetchone()
        if not trow or not str(trow["api_host"] or "").strip():
            raise HTTPException(
                status_code=503,
                detail="Tenant API host is missing from the local database; sync this tenant from an organization credential first.",
            )
        url_base = _normalize_sophos_api_base(str(trow["api_host"]).strip())
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Sophos Central credential type for {unsupported_phrase}: {id_type!r}.",
        )

    return session, url_base, tenant_hdr, org_hdr, partner_hdr


def _approve_firewall_management_on_central(
    *,
    firewall_id: str,
    tenant_id: str,
    oauth_client_id: str,
    oauth_client_secret: str,
) -> None:
    """POST approveManagement on Sophos Central (same tenancy / region rules as geo PATCH)."""
    session, url_base, tenant_hdr, org_hdr, _partner_hdr = _central_firewall_api_context(
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


def _upgrade_at_string_for_central_api(scheduled_utc: datetime | None) -> str | None:
    """Return Sophos ``upgradeAt`` string, or None for an immediate upgrade.

    If the UI sends a time that is already in the past (common with ``datetime-local``
    when the user picks the current minute), omit ``upgradeAt`` so Central treats the
    request as upgrade-now; otherwise Central may respond with errors such as
    ``BadServerResponse``.
    """
    if scheduled_utc is None:
        return None
    now = datetime.now(timezone.utc)
    if scheduled_utc <= now:
        return None
    return _sophos_upgrade_at_string(scheduled_utc)


def _post_firmware_upgrade_actions_on_central(
    *,
    oauth_client_id: str,
    oauth_client_secret: str,
    tenant_id: str,
    upgrade_dicts: list[dict],
) -> CentralResponse:
    """POST /firewall/v1/firewalls/actions/firmware-upgrade (single object or batch)."""
    session, url_base, tenant_hdr, org_hdr, _partner_hdr = _central_firewall_api_context(
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
    session, url_base, tenant_hdr, org_hdr, _partner_hdr = _central_firewall_api_context(
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
    request: Request,
    firewall_id: str,
    body: FirewallLocationBody,
    uid: str = Depends(current_user_id_dep),
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

    with get_db_readonly() as conn:
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

    au, an = _actor_for_audit(uid)
    audit_event(
        action="central.firewall_patch_geo",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "firewall_id": firewall_id,
            "tenant_id": fw_tenant_id,
            "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
        },
    )
    return {"ok": True, "geo_latitude": lat_s, "geo_longitude": lon_s}


@app.patch("/api/firewalls/{firewall_id}/label")
def api_firewall_patch_label(
    request: Request,
    firewall_id: str,
    body: FirewallLabelBody,
    uid: str = Depends(current_user_id_dep),
):
    """Set firewall display name on Sophos Central (PATCH ``name``) and update the local cache."""
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name must not be empty.")

    with get_db_readonly() as conn:
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

    au, an = _actor_for_audit(uid)
    audit_event(
        action="central.firewall_patch_name",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "firewall_id": firewall_id,
            "tenant_id": fw_tenant_id,
            "name": new_name,
            "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
        },
    )
    return {"ok": True, "name": new_name}


@app.get("/api/firmware-versions")
def api_firmware_versions():
    with get_db_readonly() as conn:
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
    with get_db_readonly() as conn:
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
    with get_db_readonly() as conn:
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
    with get_db_readonly() as conn:
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
              first_sync,
              last_sync,
              client_id,
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
        for d in rows:
            tid = d.get("id")
            if tid is None:
                d["credential_name"] = ""
                continue
            cn = credential_name_for_synced_tenant(
                sconn,
                tenant_id=str(tid),
                tenant_row_client_id=d.get("client_id"),
            )
            d["credential_name"] = cn or ""
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
                    "first_sync": "",
                    "last_sync": "",
                    "client_id": "",
                    "firewall_count": orphan_fw_counts.get(sid, 0),
                    "credential_name": label or "",
                }
            )
    rows.sort(key=lambda r: str(r.get("name") or "").casefold())
    return rows


@app.get("/api/firewall-groups")
def api_firewall_groups():
    """Rows from ``firewall_groups`` with tenant label, up to 3-segment breadcrumb, firewall count, and sync-status row count."""
    tdisp = _sql_tenant_display_coalesced("t", "g.tenant_id")
    with get_db_with_sec_readonly() as conn:
        fw_display = _firewall_id_display_map(conn)
        sql_fg = (
            """
            SELECT
              g.id,
              g.tenant_id,
              g.name AS group_name,
              p.name AS parent_name,
              pp.name AS grandparent_name,
              g.locked_by_managing_account,
              g.created_at,
              g.last_sync,
              g.updated_at,
              g.client_id,
              g.config_import_json,
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
        cfg_imp = _json_object_maybe(d.get("config_import_json"))
        sfw_id = _source_firewall_id_from_config_import(cfg_imp)
        imported_from_firewall_id: str | None = None
        if sfw_id:
            lab = str(fw_display.get(sfw_id, "") or "").strip()
            if lab:
                imported_from = lab
                imported_from_firewall_id = sfw_id
            else:
                imported_from = IMPORTED_FROM_FIREWALL_REMOVED_LABEL
        else:
            imported_from = ""
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
                "created_at": d.get("created_at") or "",
                "last_sync": d.get("last_sync") or "",
                "updated_at": d.get("updated_at") or "",
                "client_id": d.get("client_id") or "",
                "imported_from": imported_from,
                "imported_from_firewall_id": imported_from_firewall_id,
            }
        )
    return out


class CreateFirewallGroupBody(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=256)
    assign_firewall_ids: list[str] = Field(default_factory=list)
    config_import_source_firewall_id: str | None = None


class DeleteFirewallGroupsBatchBody(BaseModel):
    """Delete firewall groups on Sophos Central (per group, using tenant OAuth credentials)."""

    group_ids: list[str] = Field(default_factory=list)


@app.get("/api/tenants/{tenant_id}/firewall-group-create-data")
def api_tenant_firewall_group_create_data(
    tenant_id: str,
    _: str = Depends(current_user_id_dep),
):
    """Firewalls eligible for config-import source vs. assignment when creating a group (local DB rules)."""
    tid = str(tenant_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="Invalid tenant id.")
    with get_db_readonly() as conn:
        in_tenants = conn.execute(
            "SELECT 1 FROM tenants WHERE id = ? LIMIT 1", (tid,)
        ).fetchone()
        if not in_tenants:
            has_fw = conn.execute(
                "SELECT 1 FROM firewalls WHERE tenant_id = ? LIMIT 1", (tid,)
            ).fetchone()
            if not has_fw:
                raise HTTPException(status_code=404, detail="Tenant not found.")
        assigned = _firewall_ids_assigned_in_any_group_for_tenant(conn, tid)
        cur = conn.execute(
            """
            SELECT id, hostname, name, managing_status, reporting_status, connected, suspended,
                   capabilities_json
            FROM firewalls
            WHERE tenant_id = ?
            ORDER BY
              LOWER(COALESCE(NULLIF(TRIM(hostname), ''), NULLIF(TRIM(name), ''), id))
            """,
            (tid,),
        )
        import_sources: list[dict] = []
        available_firewalls: list[dict] = []
        for r in cur.fetchall():
            d = row_to_dict(r)
            fid = str(d.get("id") or "").strip()
            if not fid:
                continue
            ui = _firewall_row_for_group_create_ui(d)
            if _capabilities_include_config_import(d.get("capabilities_json")):
                import_sources.append(ui)
            ms = str(d.get("managing_status") or "").strip()
            if ms.startswith("approvedBy") and fid not in assigned:
                available_firewalls.append(ui)
    return {
        "tenant_id": tid,
        "import_sources": import_sources,
        "available_firewalls": available_firewalls,
    }


@app.post("/api/firewall-groups/create")
def api_firewall_groups_create(
    request: Request,
    body: CreateFirewallGroupBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    """Create a firewall group on Sophos Central (``central.firewalls.groups.methods.create_firewall_group``)."""
    tid = str(body.tenant_id or "").strip()
    name = str(body.name or "").strip()
    if not tid or not name:
        raise HTTPException(status_code=400, detail="tenant_id and name are required.")
    assign_ids = [str(x).strip() for x in (body.assign_firewall_ids or []) if str(x).strip()]
    assign_ids = list(dict.fromkeys(assign_ids))
    import_src = str(body.config_import_source_firewall_id or "").strip() or None

    with get_db_readonly() as conn:
        assigned = _firewall_ids_assigned_in_any_group_for_tenant(conn, tid)
        cur = conn.execute(
            """
            SELECT id, hostname, name, managing_status, reporting_status, connected, suspended,
                   capabilities_json
            FROM firewalls
            WHERE tenant_id = ?
            """,
            (tid,),
        )
        allowed_import: set[str] = set()
        allowed_assign: set[str] = set()
        for r in cur.fetchall():
            d = row_to_dict(r)
            fid = str(d.get("id") or "").strip()
            if not fid:
                continue
            if _capabilities_include_config_import(d.get("capabilities_json")):
                allowed_import.add(fid)
            ms = str(d.get("managing_status") or "").strip()
            if ms.startswith("approvedBy") and fid not in assigned:
                allowed_assign.add(fid)

    for aid in assign_ids:
        if aid not in allowed_assign:
            raise HTTPException(
                status_code=400,
                detail=f"Firewall {aid!r} is not eligible for this new group (tenant rules).",
            )
    if import_src is not None and import_src not in allowed_import:
        raise HTTPException(
            status_code=400,
            detail="Selected firewall is not eligible as a configuration import source for this tenant.",
        )

    au_adm, an_adm = _actor_for_audit(admin_uid)
    with get_db_readonly() as conn:
        oauth_cid, oauth_secret, cred_row_id = _oauth_client_for_tenant_firewall_api(conn, tid)

    session, url_base, _, _, _ = _central_firewall_api_context(
        oauth_client_id=oauth_cid,
        oauth_client_secret=oauth_secret,
        tenant_id=tid,
        unsupported_phrase="creating a firewall group",
    )
    rs = create_firewall_group(
        session,
        name=name,
        assign_firewalls=assign_ids,
        config_import_source_firewall_id=import_src,
        url_base=url_base,
        tenant_id=tid,
    )
    if not rs.success:
        detail = rs.message or "Create firewall group failed."
        if rs.value is not None and isinstance(rs.value, CentralResponse):
            detail = _central_api_error_message(rs.value)
        raise HTTPException(status_code=502, detail=detail)

    grp = rs.value
    group_id = getattr(grp, "id", None) if grp is not None else None
    audit_event(
        action="central.firewall_group_create",
        actor_user_id=au_adm,
        actor_username=an_adm,
        request=request,
        detail={
            "tenant_id": tid,
            "group_name": name,
            "group_id": group_id,
            "assign_count": len(assign_ids),
            "config_import_source_firewall_id": import_src,
            "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
        },
    )

    sync_results: list[dict] = []
    if cred_row_id:
        try:
            with get_db() as central_conn:
                result = run_credential_sync(
                    cred_row_id, central_conn=central_conn, trigger="post-create-firewall-group"
                )
            sync_results.append(
                {
                    "credential_id": cred_row_id,
                    "ok": result.success,
                    "error": result.error,
                }
            )
        except Exception as e:
            sync_results.append(
                {
                    "credential_id": cred_row_id,
                    "ok": False,
                    "error": str(e) or type(e).__name__,
                }
            )

    return {
        "ok": True,
        "group_id": group_id,
        "name": getattr(grp, "name", name) if grp is not None else name,
        "credential_syncs": sync_results,
    }


@app.post("/api/firewall-groups/delete-batch")
def api_firewall_groups_delete_batch(
    request: Request,
    body: DeleteFirewallGroupsBatchBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    """Delete selected firewall groups on Central via ``delete_firewall_group``; sync credentials that had a success."""
    ids = [str(x).strip() for x in body.group_ids if x is not None and str(x).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="group_ids must not be empty.")
    uniq = list(dict.fromkeys(ids))
    au_adm, an_adm = _actor_for_audit(admin_uid)
    deleted: list[dict] = []
    errors: list[dict] = []
    sync_cred_ids: set[str] = set()

    with get_db_readonly() as conn:
        for gid in uniq:
            row = conn.execute(
                """
                SELECT id, tenant_id, name
                FROM firewall_groups WHERE id = ?
                """,
                (gid,),
            ).fetchone()
            if not row:
                errors.append({"id": gid, "detail": "Group not found in local database"})
                continue
            tid = str(row["tenant_id"] or "").strip()
            gname = str(row["name"] or "").strip()
            if not tid:
                errors.append({"id": gid, "detail": "Group has no tenant id"})
                continue
            try:
                oauth_cid, oauth_secret, cred_row_id = _oauth_client_for_tenant_firewall_api(
                    conn, tid
                )
            except HTTPException as he:
                d = he.detail
                errors.append(
                    {"id": gid, "detail": d if isinstance(d, str) else str(d)}
                )
                continue

            session, url_base, _, _, _ = _central_firewall_api_context(
                oauth_client_id=oauth_cid,
                oauth_client_secret=oauth_secret,
                tenant_id=tid,
                unsupported_phrase="deleting a firewall group",
            )
            rs = delete_firewall_group(session, gid, url_base=url_base, tenant_id=tid)
            if not rs.success:
                detail = rs.message or "Delete firewall group failed."
                if rs.value is not None and isinstance(rs.value, CentralResponse):
                    detail = _central_api_error_message(rs.value)
                errors.append({"id": gid, "detail": detail})
                continue

            audit_event(
                action="central.firewall_group_delete",
                actor_user_id=au_adm,
                actor_username=an_adm,
                request=request,
                detail={
                    "tenant_id": tid,
                    "group_id": gid,
                    "group_name": gname,
                    "oauth_client_id_mask": mask_oauth_client_id(oauth_cid),
                },
            )
            deleted.append({"id": gid, "name": gname or gid})
            if cred_row_id:
                sync_cred_ids.add(cred_row_id)

    sync_results: list[dict] = []
    for cred_id in sorted(sync_cred_ids):
        try:
            with get_db() as central_conn:
                result = run_credential_sync(
                    cred_id,
                    central_conn=central_conn,
                    trigger="post-delete-firewall-group",
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
        "deleted": deleted,
        "errors": errors,
        "credential_syncs": sync_results,
    }


@app.get("/api/licenses")
def api_licenses():
    tdisp = _sql_tenant_display_coalesced("t", "l.tenant_id")
    managed_by = _sql_tenant_display_coalesced("t", "fwh.tenant_id")
    with get_db_with_sec_readonly() as conn:
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
    with get_db_with_sec_readonly() as conn:
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
    severity: list[str] | None = Query(
        default=None,
        description="Repeat: match dashboard severity filter (OR): high, medium, low",
    ),
    raised_from: str | None = Query(
        default=None,
        max_length=80,
        description="ISO raised_at range start (UTC); default 2000-01-01 if raised_to set",
    ),
    raised_to: str | None = Query(
        default=None,
        max_length=80,
        description="ISO raised_at range end (UTC); default now if raised_from set",
    ),
):
    """Distinct tenant names and firewall host labels for facet filters."""
    where_sql, bind = _alerts_where_sql(severity, None, None, None, None, raised_from, raised_to)
    base_from = """
        FROM alerts a
        LEFT JOIN tenants t ON t.id = a.tenant_id
    """
    alerts_tenant_disp = _sql_alerts_tenant_display()
    with get_db_with_sec_readonly() as conn:
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
    severity: list[str] | None = Query(
        default=None,
        description="Repeat: filter by severity (OR): high, medium, low; omit for all",
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
    raised_from: str | None = Query(
        default=None,
        max_length=80,
        description="ISO raised_at range start (UTC); default 2000-01-01 if raised_to set",
    ),
    raised_to: str | None = Query(
        default=None,
        max_length=80,
        description="ISO raised_at range end (UTC); default now if raised_from set",
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
        severity,
        tenant_name,
        firewall_hostname,
        search,
        fw_id_f,
        raised_from,
        raised_to,
    )
    sql_from = """
        FROM alerts a
        LEFT JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN firewalls fw ON fw.id = json_extract(a.managed_agent_json, '$')
    """
    alerts_tenant_disp = _sql_alerts_tenant_display()
    with get_db_with_sec_readonly() as conn:
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
              a.first_sync,
              a.last_sync,
              a.client_id,
              a.allowed_actions_json,
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
        items = []
        for r in cur.fetchall():
            d = row_to_dict(r)
            raw_aa = d.pop("allowed_actions_json", None)
            d["allowed_actions"] = _parse_alert_allowed_actions_json(raw_aa)
            items.append(d)
        _attach_alert_recency_tags(items, conn, sql_from, where_sql, bind)
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


class AlertsAcknowledgeBody(BaseModel):
    """Acknowledge alerts in Sophos Central (Common API) using stored sync credentials."""

    ids: list[str] = Field(..., min_length=1, max_length=200)


@app.post("/api/alerts/acknowledge")
def api_alerts_acknowledge(
    request: Request,
    body: AlertsAcknowledgeBody,
    uid: str = Depends(current_user_id_dep),
):
    """POST ``acknowledge`` for each id. Skips ids that are missing or not acknowledgeable locally."""
    raw_ids = [str(x).strip() for x in body.ids if x is not None and str(x).strip()]
    if not raw_ids:
        raise HTTPException(status_code=400, detail="ids must not be empty.")
    uniq = list(dict.fromkeys(raw_ids))

    au, an = _actor_for_audit(uid)
    acknowledged: list[dict] = []
    errors: list[dict] = []
    sync_cred_ids: set[str] = set()

    ph = ",".join("?" * len(uniq))
    with get_db_readonly() as conn:
        cur = conn.execute(
            f"SELECT id, tenant_id, client_id, allowed_actions_json, tenant_ref_json "
            f"FROM alerts WHERE id IN ({ph})",
            uniq,
        )
        rows = {str(r["id"]): r for r in cur.fetchall()}

    valid_entries: list[tuple[str, str, str, str | None]] = []
    for aid in uniq:
        row = rows.get(aid)
        if row is None:
            errors.append({"id": aid, "detail": "Alert not found"})
            continue
        acts = _parse_alert_allowed_actions_json(row["allowed_actions_json"])
        if not _alert_allowed_actions_include_acknowledge(acts):
            errors.append(
                {
                    "id": aid,
                    "detail": "Alert does not allow acknowledge in local data.",
                }
            )
            continue
        tid = _effective_ack_tenant_id(row["tenant_id"], row["tenant_ref_json"])
        cid = str(row["client_id"] or "").strip()
        if not tid:
            errors.append({"id": aid, "detail": "Alert has no tenant id."})
            continue
        if not cid:
            errors.append(
                {
                    "id": aid,
                    "detail": "Alert has no synced API client id; run a Central sync first.",
                }
            )
            continue
        with get_secrets_db() as sconn:
            tenant_scoped_cred_id = get_credential_id_tenant_scoped_for_central_tenant(
                sconn, tid
            )
            cred_pair = None
            cred_row_id: str | None = None
            if tenant_scoped_cred_id:
                cred_pair = get_stored_credential_secrets(sconn, tenant_scoped_cred_id)
                if cred_pair:
                    cred_row_id = tenant_scoped_cred_id
            if not cred_pair:
                cred_pair = get_stored_credential_secrets_by_client_id(sconn, cid)
                cred_row_id = get_credential_id_by_client_id(sconn, cid)
        if not cred_pair:
            errors.append(
                {
                    "id": aid,
                    "detail": "No stored Central credential matches this alert's API client id.",
                }
            )
            continue
        oauth_cid, _oauth_secret = cred_pair
        valid_entries.append((aid, oauth_cid, tid, cred_row_id))

    groups: dict[tuple[str, str], list[tuple[str, str | None]]] = defaultdict(list)
    for aid, oauth_cid, tid, cred_row_id in valid_entries:
        groups[(oauth_cid, tid)].append((aid, cred_row_id))

    for (oauth_cid, tid), entries in groups.items():
        with get_secrets_db() as sconn:
            p = get_stored_credential_secrets_by_client_id(sconn, oauth_cid)
        if not p:
            msg = "No stored Central credential for this OAuth client id."
            for aid, _ in entries:
                errors.append({"id": aid, "detail": msg})
            continue
        oauth_secret = p[1]
        try:
            session, url_base, tenant_hdr, org_hdr, _partner_hdr = _central_firewall_api_context(
                oauth_client_id=oauth_cid,
                oauth_client_secret=oauth_secret,
                tenant_id=tid,
                unsupported_phrase="alert acknowledgement",
            )
        except HTTPException as he:
            detail = he.detail
            msg = detail if isinstance(detail, str) else str(detail)
            for aid, _ in entries:
                errors.append({"id": aid, "detail": msg})
            continue

        for aid, cred_row_id in entries:
            try:
                _post_common_alert_action_on_central(
                    session=session,
                    url_base=url_base,
                    tenant_hdr=tenant_hdr,
                    org_hdr=org_hdr,
                    alert_id=aid,
                    action="acknowledge",
                )
            except HTTPException as he:
                d = he.detail
                msg = d if isinstance(d, str) else str(d)
                errors.append({"id": aid, "detail": msg})
                continue
            acknowledged.append({"id": aid})
            if cred_row_id:
                sync_cred_ids.add(str(cred_row_id))

    if acknowledged:
        audit_event(
            action="central.alerts_acknowledge",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "acknowledged_count": len(acknowledged),
                "error_count": len(errors),
            },
        )

    sync_results: list[dict] = []
    for cred_id in sorted(sync_cred_ids):
        try:
            with get_db() as central_conn:
                result = run_credential_sync(
                    cred_id, central_conn=central_conn, trigger="post-alert-acknowledge"
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
        "acknowledged": acknowledged,
        "errors": errors,
        "credential_syncs": sync_results,
    }


@app.get("/api/alerts/recent")
def api_alerts_recent(limit: int = Query(default=20, ge=1, le=200)):
    with get_db_readonly() as conn:
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
    with get_db_with_sec_readonly() as conn:
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
    sync_interval: Literal["10m", "15m", "30m", "hourly", "3h", "6h", "12h", "daily", "none"]


class CentralCredentialIncrementalSyncIntervalBody(BaseModel):
    incremental_sync_interval: Literal[
        "1m", "2m", "3m", "4m", "5m", "10m", "15m", "30m", "60m", "none"
    ]


class AppUiSettingsBody(BaseModel):
    """Firewall list recency badges: NEW / UPD windows in hours (defaults 168 and 48)."""

    fw_new_max_age_hours: int = Field(ge=1, le=8760)
    fw_updated_max_age_hours: int = Field(ge=1, le=8760)
    session_idle_timeout_minutes: int = Field(
        ge=0,
        le=525600,
        description="0 disables idle logout; cookie max_age still applies.",
    )


class GitAutoUpdateSettingsBody(BaseModel):
    interval: str = Field(min_length=1, max_length=32)


_GIT_AUTO_UPDATE_INTERVAL_SET = frozenset(GIT_AUTO_UPDATE_INTERVAL_CHOICES)


@app.get("/api/settings/ui")
def api_settings_ui_get(_: str = Depends(current_user_id_dep)):
    if not DB_PATH.exists():
        return {
            "fw_new_max_age_hours": 168,
            "fw_updated_max_age_hours": 48,
            "session_idle_timeout_minutes": 60,
        }
    row = None
    try:
        with get_db_readonly() as conn:
            row = conn.execute(
                "SELECT fw_new_max_age_hours, fw_updated_max_age_hours, session_idle_timeout_minutes "
                "FROM app_ui_settings WHERE id = 1"
            ).fetchone()
    except sqlite3.OperationalError:
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
    request: Request,
    body: AppUiSettingsBody,
    uid: str = Depends(current_user_id_dep),
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
    au, an = _actor_for_audit(uid)
    audit_event(
        action="settings.ui_update",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "fw_new_max_age_hours": body.fw_new_max_age_hours,
            "fw_updated_max_age_hours": body.fw_updated_max_age_hours,
            "session_idle_timeout_minutes": body.session_idle_timeout_minutes,
        },
    )
    return {
        "fw_new_max_age_hours": body.fw_new_max_age_hours,
        "fw_updated_max_age_hours": body.fw_updated_max_age_hours,
        "session_idle_timeout_minutes": body.session_idle_timeout_minutes,
    }


@app.get("/api/settings/git-update")
def api_settings_git_update_get(_: str = Depends(admin_user_id_dep)):
    if not git_update_page_visible():
        raise HTTPException(
            status_code=404,
            detail="Git auto-update is not available (git not on PATH or app root is not a git checkout).",
        )
    if not DB_PATH.exists():
        raise HTTPException(status_code=503, detail="Database not available")
    row = None
    try:
        with get_db_readonly() as conn:
            row = conn.execute(
                "SELECT git_auto_update_interval, git_auto_update_last_check_at, "
                "git_auto_update_last_message FROM app_ui_settings WHERE id = 1"
            ).fetchone()
    except sqlite3.OperationalError:
        with get_db() as conn:
            ensure_app_ui_schema(conn)
            row = conn.execute(
                "SELECT git_auto_update_interval, git_auto_update_last_check_at, "
                "git_auto_update_last_message FROM app_ui_settings WHERE id = 1"
            ).fetchone()
    repo = git_repo_root()
    interval = normalize_git_auto_update_interval(
        str(row["git_auto_update_interval"]) if row and row["git_auto_update_interval"] else None
    )
    return {
        "interval": interval,
        "last_check_at": str(row["git_auto_update_last_check_at"])
        if row and row["git_auto_update_last_check_at"]
        else None,
        "last_message": str(row["git_auto_update_last_message"])
        if row and row["git_auto_update_last_message"]
        else None,
        "repo_path": str(repo.resolve()) if repo else None,
    }


@app.patch("/api/settings/git-update")
def api_settings_git_update_patch(
    request: Request,
    body: GitAutoUpdateSettingsBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    if not git_update_page_visible():
        raise HTTPException(
            status_code=404,
            detail="Git auto-update is not available (git not on PATH or app root is not a git checkout).",
        )
    if not DB_PATH.exists():
        raise HTTPException(status_code=503, detail="Database not available")
    iv = body.interval.strip()
    if iv not in _GIT_AUTO_UPDATE_INTERVAL_SET:
        raise HTTPException(status_code=422, detail="Invalid git auto-update interval")
    with get_db() as conn:
        ensure_app_ui_schema(conn)
        conn.execute(
            "UPDATE app_ui_settings SET git_auto_update_interval = ? WHERE id = 1",
            (iv,),
        )
        conn.commit()
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="settings.git_auto_update",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"interval": iv},
    )
    return {
        "interval": iv,
    }


@app.get("/api/settings/credentials")
def api_settings_credentials_list(_: str = Depends(admin_user_id_dep)):
    with get_secrets_db() as conn:
        return list_credentials(conn)


@app.post("/api/settings/credentials/test")
def api_settings_credentials_test(
    request: Request,
    body: CentralCredentialSecretBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    ok, msg, whoami = _verify_central_login(body.client_id, body.client_secret)
    au, an = _actor_for_audit(admin_uid)
    if not ok:
        audit_event(
            action="central.oauth_authenticate",
            outcome="failure",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "context": "credentials_test",
                "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
                "error": _audit_err(msg),
            },
        )
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    audit_event(
        action="central.oauth_authenticate",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "context": "credentials_test",
            "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
            "id_type": whoami.get("idType") if whoami else None,
        },
    )
    return {"ok": True, "whoami": whoami, "id_type": whoami.get("idType") if whoami else None}


@app.post("/api/settings/credentials")
def api_settings_credentials_create(
    request: Request,
    body: CentralCredentialBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    ok, msg, whoami = _verify_central_login(body.client_id, body.client_secret)
    au, an = _actor_for_audit(admin_uid)
    if not ok:
        audit_event(
            action="central.oauth_authenticate",
            outcome="failure",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "context": "credential_create",
                "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
                "error": _audit_err(msg),
            },
        )
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    if not whoami or not whoami.get("idType"):
        audit_event(
            action="credential.create",
            outcome="failure",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
                "reason": "whoami_missing_id_type",
            },
        )
        raise HTTPException(status_code=400, detail="Whoami did not return idType")
    with get_secrets_db() as conn:
        row = insert_credential(
            conn,
            name=body.name,
            client_id=body.client_id,
            client_secret=body.client_secret,
            whoami=whoami,
        )
    audit_event(
        action="central.oauth_authenticate",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "context": "credential_create",
            "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
            "id_type": whoami.get("idType"),
        },
    )
    audit_event(
        action="credential.create",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "credential_id": row.get("id"),
            "credential_name": body.name.strip(),
            "oauth_client_id_mask": mask_oauth_client_id(body.client_id),
            "id_type": whoami.get("idType"),
        },
    )
    return row


@app.post("/api/settings/credentials/{cred_id}/test")
def api_settings_credentials_retest_stored(
    request: Request,
    cred_id: str,
    admin_uid: str = Depends(admin_user_id_dep),
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
    au, an = _actor_for_audit(admin_uid)
    if not ok:
        audit_event(
            action="central.oauth_authenticate",
            outcome="failure",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "context": "credentials_retest_stored",
                "credential_id": cred_id,
                "oauth_client_id_mask": mask_oauth_client_id(client_id),
                "error": _audit_err(msg),
            },
        )
        raise HTTPException(status_code=400, detail=msg or "Credential test failed")
    if not whoami or not whoami.get("idType"):
        audit_event(
            action="central.oauth_authenticate",
            outcome="failure",
            actor_user_id=au,
            actor_username=an,
            request=request,
            detail={
                "context": "credentials_retest_stored",
                "credential_id": cred_id,
                "reason": "whoami_missing_id_type",
            },
        )
        raise HTTPException(status_code=400, detail="Whoami did not return idType")

    with get_secrets_db() as conn:
        row = update_credential_whoami(conn, cred_id, whoami)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    audit_event(
        action="central.oauth_authenticate",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "context": "credentials_retest_stored",
            "credential_id": cred_id,
            "oauth_client_id_mask": mask_oauth_client_id(client_id),
            "id_type": whoami.get("idType"),
        },
    )
    audit_event(
        action="credential.whoami_refresh",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"credential_id": cred_id, "id_type": whoami.get("idType")},
    )
    return {"ok": True, "credential": row}


@app.patch("/api/settings/credentials/{cred_id}")
def api_settings_credentials_rename(
    request: Request,
    cred_id: str,
    body: CentralCredentialRenameBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        row = update_credential_name(conn, cred_id, body.name)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="credential.rename",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"credential_id": cred_id, "new_name": body.name.strip()},
    )
    return row


@app.get("/api/sync/status")
def api_sync_status(_: str = Depends(current_user_id_dep)):
    activity = get_public_sync_activity()
    with get_secrets_db() as conn:
        ts = max_last_successful_data_sync_at(conn)
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
        "sync_kind": activity["sync_kind"],
    }


@app.patch("/api/settings/credentials/{cred_id}/sync-interval")
def api_settings_credentials_sync_interval(
    request: Request,
    cred_id: str,
    body: CentralCredentialSyncIntervalBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        row = update_credential_sync_interval(conn, cred_id, body.sync_interval)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="credential.sync_interval_change",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"credential_id": cred_id, "sync_interval": body.sync_interval},
    )
    return row


@app.patch("/api/settings/credentials/{cred_id}/incremental-sync-interval")
def api_settings_credentials_incremental_sync_interval(
    request: Request,
    cred_id: str,
    body: CentralCredentialIncrementalSyncIntervalBody,
    admin_uid: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        row = update_credential_incremental_sync_interval(
            conn, cred_id, body.incremental_sync_interval
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="credential.incremental_sync_interval_change",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={
            "credential_id": cred_id,
            "incremental_sync_interval": body.incremental_sync_interval,
        },
    )
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
    request: Request,
    cred_id: str,
    admin_uid: str = Depends(admin_user_id_dep),
):
    with get_secrets_db() as conn:
        ok = delete_credential(conn, cred_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Credential not found")
    au, an = _actor_for_audit(admin_uid)
    audit_event(
        action="credential.delete",
        actor_user_id=au,
        actor_username=an,
        request=request,
        detail={"credential_id": cred_id},
    )
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
    with get_db_readonly() as conn:
        cur = conn.execute(sql, args)
        return [row_to_dict(r) for r in cur.fetchall()]


def _uvicorn_log_config() -> dict:
    """Uvicorn dictConfig plus rotating file log under logs/ (same pattern as sync_runner)."""
    from uvicorn.config import LOGGING_CONFIG

    log_dir = runtime_root() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "uvicorn.log"

    cfg = copy.deepcopy(LOGGING_CONFIG)
    cfg["formatters"]["file_plain"] = {
        "format": "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        "datefmt": "%Y-%m-%d %H:%M:%S",
    }
    cfg["handlers"]["file"] = {
        "class": "logging.handlers.RotatingFileHandler",
        "formatter": "file_plain",
        "filename": str(log_path),
        "maxBytes": 2_000_000,
        "backupCount": 5,
        "encoding": "utf-8",
    }
    cfg["loggers"]["uvicorn"]["handlers"] = ["default", "file"]
    cfg["loggers"]["uvicorn.access"]["handlers"] = ["access", "file"]
    return cfg


def main():
    import uvicorn

    frozen = bool(getattr(sys, "frozen", False))
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8765,
        reload=not frozen,
        log_config=_uvicorn_log_config(),
    )


if __name__ == "__main__":
    main()
