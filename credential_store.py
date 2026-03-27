"""SQLite store for Central API credentials with encrypted client secrets."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app_paths import runtime_root
from cryptography.fernet import Fernet, InvalidToken

SECRETS_DB_PATH = runtime_root() / "sophos_secrets.db"
FERNET_KEY_PATH = runtime_root() / "sophos_credential_key"
FERNET_ENV = "SOPHOS_CENTRAL_GUI_FERNET_KEY"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _get_fernet() -> Fernet:
    env_key = os.environ.get(FERNET_ENV)
    if env_key:
        key = env_key.strip().encode() if isinstance(env_key, str) else env_key
        return Fernet(key)
    if FERNET_KEY_PATH.exists():
        return Fernet(FERNET_KEY_PATH.read_bytes().strip())
    key = Fernet.generate_key()
    FERNET_KEY_PATH.write_bytes(key)
    try:
        os.chmod(FERNET_KEY_PATH, 0o600)
    except (NotImplementedError, OSError, AttributeError):
        pass
    return Fernet(key)


def encrypt_client_secret(plaintext: str) -> bytes:
    return _get_fernet().encrypt(plaintext.encode("utf-8"))


def decrypt_client_secret(blob: bytes) -> str:
    try:
        return _get_fernet().decrypt(blob).decode("utf-8")
    except InvalidToken as e:
        raise ValueError(
            "Could not decrypt stored secret. If you rotated the encryption key, "
            "existing rows are unreadable."
        ) from e


@contextmanager
def get_secrets_db():
    SECRETS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        SECRETS_DB_PATH,
        timeout=30,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
    finally:
        conn.close()


DEFAULT_ADMIN_USERNAME = "admin"


_APP_USER_PROFILE_COLS = frozenset({"full_name", "email", "mobile"})
_PROFILE_SET_CLAUSE_BY_COL: dict[str, str] = {
    "full_name": "full_name = ?",
    "email": "email = ?",
    "mobile": "mobile = ?",
}


def _migrate_app_users_profile_columns(conn: sqlite3.Connection) -> None:
    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(app_users)").fetchall()}
    if "full_name" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN full_name TEXT")
    if "email" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN email TEXT")
    if "mobile" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN mobile TEXT")


def _migrate_app_users_operations_ui_json(conn: sqlite3.Connection) -> None:
    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(app_users)").fetchall()}
    if "operations_ui_json" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN operations_ui_json TEXT")


def init_users_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE,
          role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          password_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (username)
        )
        """
    )
    _migrate_app_users_profile_columns(conn)
    _migrate_app_users_operations_ui_json(conn)
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_app_users_username
        ON app_users (username COLLATE NOCASE)
        """
    )


def ensure_default_admin_user(conn: sqlite3.Connection) -> None:
    init_users_schema(conn)
    n = conn.execute("SELECT COUNT(*) FROM app_users").fetchone()[0]
    if n > 0:
        return
    uid = str(uuid.uuid4())
    now = _utc_now_iso()
    conn.execute(
        """
        INSERT INTO app_users (id, username, role, password_hash, created_at, updated_at)
        VALUES (?, ?, 'admin', NULL, ?, ?)
        """,
        (uid, DEFAULT_ADMIN_USERNAME, now, now),
    )


def _password_hash_is_blank(raw: str | bytes | None) -> bool:
    if raw is None:
        return True
    if isinstance(raw, bytes):
        s = raw.decode("utf-8", errors="replace")
    else:
        s = str(raw)
    return s.strip() == ""


def clear_user_password_hash(conn: sqlite3.Connection, username: str) -> int:
    """Set password_hash to NULL for the matching user. Returns SQLite rowcount."""
    init_users_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE app_users
        SET password_hash = NULL, updated_at = ?
        WHERE LOWER(username) = LOWER(?)
        """,
        (now, username.strip()),
    )
    return int(cur.rowcount)


def count_users_with_nonblank_password(conn: sqlite3.Connection) -> int:
    init_users_schema(conn)
    r = conn.execute(
        """
        SELECT COUNT(*) FROM app_users
        WHERE password_hash IS NOT NULL AND TRIM(COALESCE(password_hash, '')) != ''
        """
    ).fetchone()
    return int(r[0]) if r and r[0] is not None else 0


def needs_initial_admin_password(conn: sqlite3.Connection) -> bool:
    """True when no user has a password yet but at least one admin exists (bootstrap / full reset)."""
    init_users_schema(conn)
    ensure_default_admin_user(conn)
    if count_users_with_nonblank_password(conn) > 0:
        return False
    total_row = conn.execute("SELECT COUNT(*) FROM app_users").fetchone()
    total = int(total_row[0]) if total_row and total_row[0] is not None else 0
    if total < 1:
        return False
    n_admin = conn.execute(
        "SELECT COUNT(*) FROM app_users WHERE LOWER(COALESCE(role, '')) = 'admin'"
    ).fetchone()
    return int(n_admin[0] if n_admin and n_admin[0] is not None else 0) >= 1


def bootstrap_setup_target_user_id(conn: sqlite3.Connection) -> str | None:
    """User id that receives the password during POST /api/auth/setup-admin-password."""
    if not needs_initial_admin_password(conn):
        return None
    row = conn.execute(
        """
        SELECT id FROM app_users
        WHERE LOWER(username) = LOWER(?) AND LOWER(COALESCE(role, '')) = 'admin'
        LIMIT 1
        """,
        (DEFAULT_ADMIN_USERNAME,),
    ).fetchone()
    if row:
        return str(row["id"])
    row = conn.execute(
        """
        SELECT id FROM app_users
        WHERE LOWER(COALESCE(role, '')) = 'admin'
        ORDER BY datetime(created_at) ASC
        LIMIT 1
        """
    ).fetchone()
    return str(row["id"]) if row else None


def user_row_public(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "full_name": row["full_name"] if "full_name" in keys else None,
        "email": row["email"] if "email" in keys else None,
        "mobile": row["mobile"] if "mobile" in keys else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_app_users(conn: sqlite3.Connection) -> list[dict]:
    init_users_schema(conn)
    ensure_default_admin_user(conn)
    cur = conn.execute(
        """
        SELECT id, username, role, full_name, email, mobile, created_at, updated_at
        FROM app_users
        ORDER BY username COLLATE NOCASE
        """
    )
    return [user_row_public(r) for r in cur.fetchall()]


def get_app_user_by_id(conn: sqlite3.Connection, user_id: str) -> sqlite3.Row | None:
    init_users_schema(conn)
    return conn.execute(
        """
        SELECT id, username, role, password_hash, full_name, email, mobile, created_at, updated_at
        FROM app_users WHERE id = ?
        """,
        (user_id,),
    ).fetchone()


def get_app_user_by_username(conn: sqlite3.Connection, username: str) -> sqlite3.Row | None:
    init_users_schema(conn)
    return conn.execute(
        """
        SELECT id, username, role, password_hash, full_name, email, mobile, created_at, updated_at
        FROM app_users WHERE username = ?
        """,
        (username.strip(),),
    ).fetchone()


def count_admins(conn: sqlite3.Connection) -> int:
    init_users_schema(conn)
    r = conn.execute("SELECT COUNT(*) FROM app_users WHERE role = 'admin'").fetchone()
    return int(r[0]) if r else 0


def _optional_profile_str(value: str | None) -> str | None:
    if value is None:
        return None
    t = str(value).strip()
    return t if t else None


def insert_app_user(
    conn: sqlite3.Connection,
    *,
    username: str,
    role: str,
    password_hash: str,
    full_name: str | None = None,
    email: str | None = None,
    mobile: str | None = None,
) -> dict:
    init_users_schema(conn)
    uid = str(uuid.uuid4())
    now = _utc_now_iso()
    fn = _optional_profile_str(full_name)
    em = _optional_profile_str(email)
    mob = _optional_profile_str(mobile)
    conn.execute(
        """
        INSERT INTO app_users (id, username, role, password_hash, full_name, email, mobile, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (uid, username.strip(), role, password_hash, fn, em, mob, now, now),
    )
    row = conn.execute(
        """
        SELECT id, username, role, full_name, email, mobile, created_at, updated_at
        FROM app_users WHERE id = ?
        """,
        (uid,),
    ).fetchone()
    return user_row_public(row)


def update_app_user_role(conn: sqlite3.Connection, user_id: str, role: str) -> dict | None:
    init_users_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        "UPDATE app_users SET role = ?, updated_at = ? WHERE id = ?",
        (role, now, user_id),
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, username, role, full_name, email, mobile, created_at, updated_at
        FROM app_users WHERE id = ?
        """,
        (user_id,),
    ).fetchone()
    return user_row_public(row) if row else None


def update_app_user_profile_cols(
    conn: sqlite3.Connection, user_id: str, updates: dict[str, str | None]
) -> dict | None:
    """Set profile columns. Each value is stored as-is; use None for SQL NULL. Keys must be in _APP_USER_PROFILE_COLS."""
    init_users_schema(conn)
    if not updates:
        row = conn.execute(
            """
            SELECT id, username, role, full_name, email, mobile, created_at, updated_at
            FROM app_users WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
        return user_row_public(row) if row else None
    bad = set(updates) - _APP_USER_PROFILE_COLS
    if bad:
        raise ValueError(f"invalid profile column keys: {sorted(bad)}")
    now = _utc_now_iso()
    parts: list[str] = []
    vals: list[str | None] = []
    for col, val in updates.items():
        parts.append(_PROFILE_SET_CLAUSE_BY_COL[col])
        vals.append(val)
    vals.append(now)
    vals.append(user_id)
    set_sql = ", ".join(parts)
    cur = conn.execute(
        "UPDATE app_users SET " + set_sql + ", updated_at = ? WHERE id = ?",
        vals,
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, username, role, full_name, email, mobile, created_at, updated_at
        FROM app_users WHERE id = ?
        """,
        (user_id,),
    ).fetchone()
    return user_row_public(row) if row else None


def update_app_user_password_hash(conn: sqlite3.Connection, user_id: str, password_hash: str) -> bool:
    init_users_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        "UPDATE app_users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (password_hash, now, user_id),
    )
    return cur.rowcount > 0


def delete_app_user(conn: sqlite3.Connection, user_id: str) -> bool:
    init_users_schema(conn)
    cur = conn.execute("DELETE FROM app_users WHERE id = ?", (user_id,))
    return cur.rowcount > 0


def get_user_operations_ui_json(conn: sqlite3.Connection, user_id: str) -> str | None:
    init_users_schema(conn)
    row = conn.execute(
        "SELECT operations_ui_json FROM app_users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        return None
    raw = row["operations_ui_json"]
    return None if raw is None else str(raw)


def set_user_operations_ui_json(conn: sqlite3.Connection, user_id: str, payload: str) -> bool:
    init_users_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE app_users SET operations_ui_json = ?, updated_at = ?
        WHERE id = ?
        """,
        (payload, now, user_id),
    )
    return cur.rowcount > 0


DEFAULT_SYNC_INTERVAL = "12h"
DEFAULT_INCREMENTAL_SYNC_INTERVAL = "15m"

CREDENTIAL_SYNC_INTERVAL_SECONDS: dict[str, int | None] = {
    "10m": 600,
    "15m": 900,
    "30m": 1800,
    "hourly": 3600,
    "3h": 10800,
    "6h": 21600,
    "12h": 43200,
    "daily": 86400,
    "none": None,
}

CREDENTIAL_INCREMENTAL_SYNC_INTERVAL_SECONDS: dict[str, int | None] = {
    "1m": 60,
    "2m": 120,
    "3m": 180,
    "4m": 240,
    "5m": 300,
    "10m": 600,
    "15m": 900,
    "30m": 1800,
    "60m": 3600,
    "none": None,
}

SYNC_INTERVAL_DISPLAY: dict[str, str] = {
    "10m": "Every 10 minutes",
    "15m": "Every 15 minutes",
    "30m": "Every 30 minutes",
    "hourly": "Hourly",
    "3h": "Every 3 hours",
    "6h": "Every 6 hours",
    "12h": "Every 12 hours",
    "daily": "Daily",
    "none": "Not scheduled",
}

INCREMENTAL_SYNC_INTERVAL_DISPLAY: dict[str, str] = {
    "1m": "Every 1 minute",
    "2m": "Every 2 minutes",
    "3m": "Every 3 minutes",
    "4m": "Every 4 minutes",
    "5m": "Every 5 minutes",
    "10m": "Every 10 minutes",
    "15m": "Every 15 minutes",
    "30m": "Every 30 minutes",
    "60m": "Every 60 minutes",
    "none": "Not scheduled",
}


def sync_interval_display_label(interval_key: str) -> str:
    k = (interval_key or "").strip()
    if not k:
        k = DEFAULT_SYNC_INTERVAL
    return SYNC_INTERVAL_DISPLAY.get(k, k)


def incremental_sync_interval_display_label(interval_key: str) -> str:
    k = (interval_key or "").strip()
    if not k:
        k = DEFAULT_INCREMENTAL_SYNC_INTERVAL
    return INCREMENTAL_SYNC_INTERVAL_DISPLAY.get(k, k)


def credentials_interval_summary(creds: list[dict]) -> str:
    """Human-readable full + incremental schedules for the status bar (unique order preserved)."""
    ordered_full: list[str] = []
    ordered_incr: list[str] = []
    for c in creds:
        iv = str(c.get("sync_interval") or "").strip() or DEFAULT_SYNC_INTERVAL
        if iv != "none" and iv not in ordered_full:
            ordered_full.append(iv)
        ij = (
            str(c.get("incremental_sync_interval") or "").strip()
            or DEFAULT_INCREMENTAL_SYNC_INTERVAL
        )
        if ij != "none" and ij not in ordered_incr:
            ordered_incr.append(ij)
    chunks: list[str] = []
    if ordered_full:
        parts = [sync_interval_display_label(k) for k in ordered_full]
        if len(parts) > 3:
            fstr = f"{', '.join(parts[:3])}, …"
        else:
            fstr = ", ".join(parts)
        chunks.append(f"Full: {fstr}")
    if ordered_incr:
        parts = [incremental_sync_interval_display_label(k) for k in ordered_incr]
        if len(parts) > 3:
            istr = f"{', '.join(parts[:3])}, …"
        else:
            istr = ", ".join(parts)
        chunks.append(f"Incr: {istr}")
    if not chunks:
        return "—"
    return " · ".join(chunks)


def next_scheduled_sync_at_iso(last_sync_iso: str | None, sync_interval: str) -> str | None:
    """UTC ISO timestamp of last successful sync plus interval, or None if not scheduled."""
    iv = (sync_interval or "").strip()
    sec = CREDENTIAL_SYNC_INTERVAL_SECONDS.get(iv)
    if sec is None:
        return None
    if not last_sync_iso or not str(last_sync_iso).strip():
        return None
    try:
        t = str(last_sync_iso).strip().replace("Z", "+00:00")
        last = datetime.fromisoformat(t)
    except ValueError:
        return None
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    else:
        last = last.astimezone(timezone.utc)
    nxt = (last + timedelta(seconds=sec)).replace(microsecond=0)
    return nxt.isoformat()


def next_scheduled_incremental_sync_at_iso(
    last_incremental_iso: str | None, incremental_interval: str
) -> str | None:
    """UTC ISO timestamp of last successful incremental sync plus interval, or None if not scheduled."""
    iv = (incremental_interval or "").strip()
    sec = CREDENTIAL_INCREMENTAL_SYNC_INTERVAL_SECONDS.get(iv)
    if sec is None:
        return None
    if not last_incremental_iso or not str(last_incremental_iso).strip():
        return None
    try:
        t = str(last_incremental_iso).strip().replace("Z", "+00:00")
        last = datetime.fromisoformat(t)
    except ValueError:
        return None
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    else:
        last = last.astimezone(timezone.utc)
    nxt = (last + timedelta(seconds=sec)).replace(microsecond=0)
    return nxt.isoformat()


def init_secrets_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS central_credentials (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          client_id TEXT NOT NULL,
          client_secret_enc BLOB NOT NULL,
          id_type TEXT NOT NULL,
          whoami_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sync_interval TEXT NOT NULL DEFAULT '12h',
          incremental_sync_interval TEXT NOT NULL DEFAULT '15m',
          last_successful_incremental_sync_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_central_credentials_name
        ON central_credentials (name COLLATE NOCASE)
        """
    )
    _migrate_central_credentials_sync_interval(conn)
    _migrate_central_credentials_last_successful_sync_at(conn)
    _migrate_central_credentials_incremental_sync(conn)


def _migrate_central_credentials_incremental_sync(conn: sqlite3.Connection) -> None:
    cols = {
        str(r[1])
        for r in conn.execute("PRAGMA table_info(central_credentials)").fetchall()
    }
    if "incremental_sync_interval" not in cols:
        conn.execute(
            """
            ALTER TABLE central_credentials
            ADD COLUMN incremental_sync_interval TEXT NOT NULL DEFAULT '15m'
            """
        )
    if "last_successful_incremental_sync_at" not in cols:
        conn.execute(
            """
            ALTER TABLE central_credentials
            ADD COLUMN last_successful_incremental_sync_at TEXT
            """
        )


def _migrate_central_credentials_sync_interval(conn: sqlite3.Connection) -> None:
    cols = {
        str(r[1])
        for r in conn.execute("PRAGMA table_info(central_credentials)").fetchall()
    }
    if "sync_interval" not in cols:
        conn.execute(
            """
            ALTER TABLE central_credentials
            ADD COLUMN sync_interval TEXT NOT NULL DEFAULT '12h'
            """
        )


def _migrate_central_credentials_last_successful_sync_at(conn: sqlite3.Connection) -> None:
    cols = {
        str(r[1])
        for r in conn.execute("PRAGMA table_info(central_credentials)").fetchall()
    }
    if "last_successful_sync_at" not in cols:
        conn.execute(
            """
            ALTER TABLE central_credentials
            ADD COLUMN last_successful_sync_at TEXT
            """
        )


def row_public(row: sqlite3.Row) -> dict:
    whoami = {}
    try:
        whoami = json.loads(row["whoami_json"] or "{}")
    except json.JSONDecodeError:
        pass
    raw_interval = row["sync_interval"] if "sync_interval" in row.keys() else None
    sync_interval = (
        str(raw_interval).strip()
        if raw_interval is not None and str(raw_interval).strip() != ""
        else DEFAULT_SYNC_INTERVAL
    )
    raw_incr_iv = row["incremental_sync_interval"] if "incremental_sync_interval" in row.keys() else None
    incremental_sync_interval = (
        str(raw_incr_iv).strip()
        if raw_incr_iv is not None and str(raw_incr_iv).strip() != ""
        else DEFAULT_INCREMENTAL_SYNC_INTERVAL
    )
    last_sync = None
    if "last_successful_sync_at" in row.keys():
        raw_ls = row["last_successful_sync_at"]
        if raw_ls is not None and str(raw_ls).strip() != "":
            last_sync = str(raw_ls).strip()
    last_incremental_sync = None
    if "last_successful_incremental_sync_at" in row.keys():
        raw_li = row["last_successful_incremental_sync_at"]
        if raw_li is not None and str(raw_li).strip() != "":
            last_incremental_sync = str(raw_li).strip()
    nxt = next_scheduled_sync_at_iso(last_sync, sync_interval)
    nxt_incr = next_scheduled_incremental_sync_at_iso(
        last_incremental_sync, incremental_sync_interval
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "client_id": row["client_id"],
        "id_type": row["id_type"],
        "whoami": whoami,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "sync_interval": sync_interval,
        "incremental_sync_interval": incremental_sync_interval,
        "last_sync": last_sync,
        "next_scheduled_sync_at": nxt,
        "last_incremental_sync": last_incremental_sync,
        "next_scheduled_incremental_sync_at": nxt_incr,
    }


def list_credentials(conn: sqlite3.Connection) -> list[dict]:
    init_secrets_schema(conn)
    cur = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials
        ORDER BY name COLLATE NOCASE
        """
    )
    return [row_public(r) for r in cur.fetchall()]


def get_credential_by_id(conn: sqlite3.Connection, cred_id: str) -> dict | None:
    init_secrets_schema(conn)
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row) if row else None


def credential_name_for_tenant_client_id(
    conn: sqlite3.Connection, tenant_id: str
) -> str | None:
    """Friendly name when client_id or whoami.id matches this tenant UUID."""
    tid = str(tenant_id).strip()
    if not tid:
        return None
    init_secrets_schema(conn)
    row = conn.execute(
        """
        SELECT name FROM central_credentials
        WHERE TRIM(client_id) = TRIM(?)
           OR (
             json_valid(whoami_json)
             AND TRIM(json_extract(whoami_json, '$.id')) = TRIM(?)
           )
        ORDER BY name COLLATE NOCASE
        LIMIT 1
        """,
        (tid, tid),
    ).fetchone()
    if not row or row["name"] is None:
        return None
    label = str(row["name"]).strip()
    return label or None


def credential_name_for_synced_tenant(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    tenant_row_client_id: str | None = None,
) -> str | None:
    """
    Stored Central credential display name for tenant rows: match Sophos tenant UUID to
    credential ``client_id`` / whoami id, else the OAuth application id on the synced tenant row.
    """
    tid = str(tenant_id or "").strip()
    if tid:
        by_uuid = credential_name_for_tenant_client_id(conn, tid)
        if by_uuid:
            return by_uuid
    oc = str(tenant_row_client_id or "").strip()
    if not oc:
        return None
    init_secrets_schema(conn)
    row = conn.execute(
        """
        SELECT name FROM central_credentials
        WHERE TRIM(client_id) = TRIM(?)
        ORDER BY name COLLATE NOCASE
        LIMIT 1
        """,
        (oc,),
    ).fetchone()
    if not row or row["name"] is None:
        return None
    label = str(row["name"]).strip()
    return label or None


def insert_credential(
    conn: sqlite3.Connection,
    *,
    name: str,
    client_id: str,
    client_secret: str,
    whoami: dict,
) -> dict:
    init_secrets_schema(conn)
    cid = str(uuid.uuid4())
    now = _utc_now_iso()
    id_type = str(whoami.get("idType") or whoami.get("id_type") or "")
    whoami_json = json.dumps(whoami, separators=(",", ":"))
    enc = encrypt_client_secret(client_secret)
    conn.execute(
        """
        INSERT INTO central_credentials
          (id, name, client_id, client_secret_enc, id_type, whoami_json, created_at, updated_at, sync_interval,
           incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        """,
        (
            cid,
            name.strip(),
            client_id.strip(),
            enc,
            id_type,
            whoami_json,
            now,
            now,
            DEFAULT_SYNC_INTERVAL,
            DEFAULT_INCREMENTAL_SYNC_INTERVAL,
        ),
    )
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cid,),
    ).fetchone()
    return row_public(row)


def update_credential_name(conn: sqlite3.Connection, cred_id: str, name: str) -> dict | None:
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials SET name = ?, updated_at = ? WHERE id = ?
        """,
        (name.strip(), now, cred_id),
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row)


def update_credential_sync_interval(
    conn: sqlite3.Connection, cred_id: str, sync_interval: str
) -> dict | None:
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials SET sync_interval = ?, updated_at = ? WHERE id = ?
        """,
        (sync_interval.strip(), now, cred_id),
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row) if row else None


def update_credential_incremental_sync_interval(
    conn: sqlite3.Connection, cred_id: str, incremental_sync_interval: str
) -> dict | None:
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials SET incremental_sync_interval = ?, updated_at = ? WHERE id = ?
        """,
        (incremental_sync_interval.strip(), now, cred_id),
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row) if row else None


def delete_credential(conn: sqlite3.Connection, cred_id: str) -> bool:
    init_secrets_schema(conn)
    cur = conn.execute("DELETE FROM central_credentials WHERE id = ?", (cred_id,))
    return cur.rowcount > 0


def get_stored_credential_secrets(conn: sqlite3.Connection, cred_id: str) -> tuple[str, str] | None:
    """Return (client_id, plaintext client_secret) for an existing row, or None if missing."""
    init_secrets_schema(conn)
    row = conn.execute(
        "SELECT client_id, client_secret_enc FROM central_credentials WHERE id = ?",
        (cred_id,),
    ).fetchone()
    if not row:
        return None
    secret = decrypt_client_secret(row["client_secret_enc"])
    return row["client_id"], secret


def get_credential_id_by_client_id(conn: sqlite3.Connection, oauth_client_id: str) -> str | None:
    """Return the ``central_credentials.id`` for the stored OAuth client id, if any."""
    init_secrets_schema(conn)
    oid = str(oauth_client_id).strip()
    if not oid:
        return None
    row = conn.execute(
        """
        SELECT id FROM central_credentials
        WHERE TRIM(client_id) = TRIM(?)
        ORDER BY name COLLATE NOCASE
        LIMIT 1
        """,
        (oid,),
    ).fetchone()
    return str(row["id"]) if row else None


def get_credential_id_tenant_scoped_for_central_tenant(
    conn: sqlite3.Connection, central_tenant_id: str
) -> str | None:
    """
    Return ``central_credentials.id`` for a stored API client whose whoami is tenant-scoped
    (``idType`` / ``id_type`` tenant) and whose whoami ``id`` equals the Sophos Central tenant UUID.

    Used to prefer a tenant service principal for Common API alert actions when the alert row
    still carries a partner (or other) OAuth ``client_id`` from sync.
    """
    init_secrets_schema(conn)
    tid = str(central_tenant_id or "").strip()
    if not tid:
        return None
    row = conn.execute(
        """
        SELECT id FROM central_credentials
        WHERE LOWER(TRIM(COALESCE(id_type, ''))) = 'tenant'
          AND json_valid(whoami_json)
          AND LOWER(TRIM(COALESCE(json_extract(whoami_json, '$.id'), ''))) = LOWER(TRIM(?))
        ORDER BY name COLLATE NOCASE
        LIMIT 1
        """,
        (tid,),
    ).fetchone()
    return str(row["id"]) if row else None


def get_stored_credential_secrets_by_client_id(
    conn: sqlite3.Connection, oauth_client_id: str
) -> tuple[str, str] | None:
    """
    Return (client_id, plaintext client_secret) for the stored credential whose
    ``client_id`` matches the OAuth application id recorded on synced firewall rows.
    If several rows share the same client_id, the first by name wins.
    """
    init_secrets_schema(conn)
    oid = str(oauth_client_id).strip()
    if not oid:
        return None
    row = conn.execute(
        """
        SELECT client_id, client_secret_enc
        FROM central_credentials
        WHERE TRIM(client_id) = TRIM(?)
        ORDER BY name COLLATE NOCASE
        LIMIT 1
        """,
        (oid,),
    ).fetchone()
    if not row:
        return None
    secret = decrypt_client_secret(row["client_secret_enc"])
    return row["client_id"], secret


def update_credential_whoami(conn: sqlite3.Connection, cred_id: str, whoami: dict) -> dict | None:
    """Refresh id_type and whoami_json after a successful live test."""
    init_secrets_schema(conn)
    id_type = str(whoami.get("idType") or whoami.get("id_type") or "")
    whoami_json = json.dumps(whoami, separators=(",", ":"))
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials
        SET id_type = ?, whoami_json = ?, updated_at = ?
        WHERE id = ?
        """,
        (id_type, whoami_json, now, cred_id),
    )
    if cur.rowcount == 0:
        return None
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               incremental_sync_interval, last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row)


def touch_credential_last_successful_sync(conn: sqlite3.Connection, cred_id: str) -> bool:
    """Set full and incremental last-sync times to now after a successful full sync."""
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials
        SET last_successful_sync_at = ?,
            last_successful_incremental_sync_at = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (now, now, now, cred_id),
    )
    return cur.rowcount > 0


def touch_credential_last_successful_incremental_sync(
    conn: sqlite3.Connection, cred_id: str
) -> bool:
    """Set last_successful_incremental_sync_at to now after a successful incremental sync."""
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials
        SET last_successful_incremental_sync_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (now, now, cred_id),
    )
    return cur.rowcount > 0


def _parse_iso_utc_naive_max(a: str, b: str) -> str:
    if not a:
        return b
    if not b:
        return a
    try:
        da = datetime.fromisoformat(str(a).strip().replace("Z", "+00:00"))
        db = datetime.fromisoformat(str(b).strip().replace("Z", "+00:00"))
    except ValueError:
        return a if a > b else b
    if da.tzinfo is None:
        da = da.replace(tzinfo=timezone.utc)
    else:
        da = da.astimezone(timezone.utc)
    if db.tzinfo is None:
        db = db.replace(tzinfo=timezone.utc)
    else:
        db = db.astimezone(timezone.utc)
    return a if da >= db else b


def max_last_successful_sync_at(conn: sqlite3.Connection) -> str | None:
    """Latest successful full Central data sync time across all credentials (ISO UTC), or None."""
    init_secrets_schema(conn)
    row = conn.execute(
        """
        SELECT MAX(last_successful_sync_at) AS m
        FROM central_credentials
        WHERE last_successful_sync_at IS NOT NULL AND TRIM(last_successful_sync_at) != ''
        """
    ).fetchone()
    if not row or row["m"] is None:
        return None
    s = str(row["m"]).strip()
    return s or None


def max_last_successful_data_sync_at(conn: sqlite3.Connection) -> str | None:
    """Latest successful full or incremental sync time across credentials (ISO UTC), or None."""
    init_secrets_schema(conn)
    rows = conn.execute(
        """
        SELECT last_successful_sync_at, last_successful_incremental_sync_at
        FROM central_credentials
        """
    ).fetchall()
    best: str | None = None
    for r in rows:
        fs = r["last_successful_sync_at"]
        ins = r["last_successful_incremental_sync_at"]
        fs_s = str(fs).strip() if fs is not None and str(fs).strip() else ""
        ins_s = str(ins).strip() if ins is not None and str(ins).strip() else ""
        if not fs_s and not ins_s:
            continue
        row_best = fs_s
        if ins_s:
            row_best = _parse_iso_utc_naive_max(fs_s, ins_s) if fs_s else ins_s
        if not best:
            best = row_best
        else:
            best = _parse_iso_utc_naive_max(best, row_best)
    return best


def count_credentials_by_id_type(conn: sqlite3.Connection) -> dict[str, int]:
    """Counts Central credentials grouped by stored id_type (whoami idType)."""
    init_secrets_schema(conn)
    cur = conn.execute(
        """
        SELECT COALESCE(NULLIF(TRIM(id_type), ''), 'unknown') AS t, COUNT(*) AS n
        FROM central_credentials
        GROUP BY t
        ORDER BY t COLLATE NOCASE
        """
    )
    return {str(r["t"]): int(r["n"]) for r in cur.fetchall()}


def whoami_dict_from_session(session) -> dict:
    w = session.whoami
    if w is None:
        return {}
    return asdict(w)
