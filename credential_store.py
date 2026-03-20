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

from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent
SECRETS_DB_PATH = ROOT / "sophos_secrets.db"
FERNET_KEY_PATH = ROOT / "sophos_credential_key"
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


def _migrate_app_users_profile_columns(conn: sqlite3.Connection) -> None:
    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(app_users)").fetchall()}
    if "full_name" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN full_name TEXT")
    if "email" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN email TEXT")
    if "mobile" not in cols:
        conn.execute("ALTER TABLE app_users ADD COLUMN mobile TEXT")


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
        parts.append(f"{col} = ?")
        vals.append(val)
    vals.append(now)
    vals.append(user_id)
    cur = conn.execute(
        f"UPDATE app_users SET {', '.join(parts)}, updated_at = ? WHERE id = ?",
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


DEFAULT_SYNC_INTERVAL = "12h"

CREDENTIAL_SYNC_INTERVAL_SECONDS: dict[str, int | None] = {
    "hourly": 3600,
    "3h": 10800,
    "6h": 21600,
    "12h": 43200,
    "daily": 86400,
    "none": None,
}


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
          sync_interval TEXT NOT NULL DEFAULT '12h'
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
    last_sync = None
    if "last_successful_sync_at" in row.keys():
        raw_ls = row["last_successful_sync_at"]
        if raw_ls is not None and str(raw_ls).strip() != "":
            last_sync = str(raw_ls).strip()
    nxt = next_scheduled_sync_at_iso(last_sync, sync_interval)
    return {
        "id": row["id"],
        "name": row["name"],
        "client_id": row["client_id"],
        "id_type": row["id_type"],
        "whoami": whoami,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "sync_interval": sync_interval,
        "last_sync": last_sync,
        "next_scheduled_sync_at": nxt,
    }


def list_credentials(conn: sqlite3.Connection) -> list[dict]:
    init_secrets_schema(conn)
    cur = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               last_successful_sync_at
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
               last_successful_sync_at
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
           last_successful_sync_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (cid, name.strip(), client_id.strip(), enc, id_type, whoami_json, now, now, DEFAULT_SYNC_INTERVAL),
    )
    row = conn.execute(
        """
        SELECT id, name, client_id, id_type, whoami_json, created_at, updated_at, sync_interval,
               last_successful_sync_at
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
               last_successful_sync_at
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
               last_successful_sync_at
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
               last_successful_sync_at
        FROM central_credentials WHERE id = ?
        """,
        (cred_id,),
    ).fetchone()
    return row_public(row)


def touch_credential_last_successful_sync(conn: sqlite3.Connection, cred_id: str) -> bool:
    """Set last_successful_sync_at to now for this credential. Returns True if a row was updated."""
    init_secrets_schema(conn)
    now = _utc_now_iso()
    cur = conn.execute(
        """
        UPDATE central_credentials
        SET last_successful_sync_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (now, now, cred_id),
    )
    return cur.rowcount > 0


def max_last_successful_sync_at(conn: sqlite3.Connection) -> str | None:
    """Latest successful Central data sync time across all credentials (ISO UTC), or None."""
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


def whoami_dict_from_session(session) -> dict:
    w = session.whoami
    if w is None:
        return {}
    return asdict(w)
