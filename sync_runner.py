"""Run Central → local DB sync for one credential; file logging and serialized execution."""

from __future__ import annotations

import logging
import threading
import time as time_module
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler

from app_paths import runtime_root
from central.db import init_schema
from central.session import CentralSession
from central.sync_to_db import CentralSyncAuthError, sync_client_credentials_to_database

from credential_store import (
    get_credential_by_id,
    get_secrets_db,
    get_stored_credential_secrets,
    touch_credential_last_successful_sync,
    update_credential_whoami,
    whoami_dict_from_session,
)

LOGS_DIR = runtime_root() / "logs"
SYNC_LOG = LOGS_DIR / "sync.log"

_sync_logger_configured = False
_sync_lock = threading.Lock()
_sync_activity_lock = threading.Lock()
# Shown in /api/sync/status while a sync holds _sync_lock (does not block on that lock).
_sync_activity: dict[str, str | None] = {
    "credential_id": None,
    "credential_name": None,
    "trigger": None,
}


def _set_sync_activity(
    cred_id: str | None, credential_name: str | None, trigger: str | None
) -> None:
    with _sync_activity_lock:
        _sync_activity["credential_id"] = cred_id
        _sync_activity["credential_name"] = credential_name
        _sync_activity["trigger"] = trigger


def get_public_sync_activity() -> dict[str, str | bool | None]:
    with _sync_activity_lock:
        cid = _sync_activity["credential_id"]
        return {
            "busy": cid is not None,
            "credential_id": cid,
            "credential_name": _sync_activity["credential_name"],
            "trigger": _sync_activity["trigger"],
        }


def configure_sync_file_logging() -> logging.Logger:
    global _sync_logger_configured
    log = logging.getLogger("sophos_central_gui.sync")
    if _sync_logger_configured:
        return log
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.INFO)
    log.propagate = False
    fh = RotatingFileHandler(
        SYNC_LOG,
        maxBytes=2_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    _fmt = logging.Formatter(
        "%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    _fmt.converter = time_module.gmtime
    fh.setFormatter(_fmt)
    log.addHandler(fh)
    _sync_logger_configured = True
    return log


@dataclass
class CredentialSyncResult:
    success: bool
    cred_id: str
    client_id: str
    error: str | None
    sync_id: str | None
    trigger: str
    credential: dict | None = None
    summary: object | None = None


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


def run_credential_sync(
    cred_id: str,
    *,
    central_conn,
    trigger: str = "manual",
) -> CredentialSyncResult:
    """
    Sync one credential into ``central_conn`` (sophos_central.db), refresh whoami, record last sync.
    Callers must pass an open sqlite connection to the Central database.
    """
    log = configure_sync_file_logging()
    client_id_for_log = ""
    with _sync_lock:
        with get_secrets_db() as sconn:
            try:
                pair = get_stored_credential_secrets(sconn, cred_id)
            except ValueError as e:
                msg = str(e) or "Could not decrypt stored secret"
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    "",
                    trigger,
                    msg.replace("\n", " "),
                )
                return CredentialSyncResult(False, cred_id, "", msg, None, trigger, None)
            if pair is None:
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    "",
                    trigger,
                    "Credential not found",
                )
                return CredentialSyncResult(
                    False, cred_id, "", "Credential not found", None, trigger, None
                )
            client_id, client_secret = pair
            client_id_for_log = (client_id or "").strip()
            cred_row = get_credential_by_id(sconn, cred_id)
            display_name = str((cred_row or {}).get("name") or "").strip() or cred_id

        _set_sync_activity(cred_id, display_name, trigger)
        try:
            init_schema(central_conn)
            sync_id: str | None = None
            sync_summary: object | None = None
            try:
                sync_result = sync_client_credentials_to_database(
                    central_conn, client_id, client_secret, quiet=True
                )
                sync_id = getattr(sync_result, "sync_id", None)
                if sync_id is not None:
                    sync_id = str(sync_id)
                sync_summary = getattr(sync_result, "summary", None)
            except CentralSyncAuthError as e:
                central_conn.rollback()
                err = e.message or "Central authentication failed"
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    client_id_for_log,
                    trigger,
                    err.replace("\n", " "),
                )
                return CredentialSyncResult(False, cred_id, client_id_for_log, err, None, trigger, None)
            except Exception as e:
                central_conn.rollback()
                err = str(e) or type(e).__name__
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    client_id_for_log,
                    trigger,
                    err.replace("\n", " "),
                )
                return CredentialSyncResult(
                    False, cred_id, client_id_for_log, err, None, trigger, None
                )

            ok, msg, whoami = _verify_central_login(client_id, client_secret)
            if not ok:
                err = msg or "Could not refresh profile after sync"
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    client_id_for_log,
                    trigger,
                    err.replace("\n", " "),
                )
                return CredentialSyncResult(
                    False, cred_id, client_id_for_log, err, sync_id, trigger, None
                )
            if not whoami or not whoami.get("idType"):
                err = "Whoami did not return idType"
                log.info(
                    "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                    cred_id,
                    client_id_for_log,
                    trigger,
                    err,
                )
                return CredentialSyncResult(
                    False, cred_id, client_id_for_log, err, sync_id, trigger, None
                )

            with get_secrets_db() as sconn:
                row = update_credential_whoami(sconn, cred_id, whoami)
                if row is None:
                    err = "Credential not found after sync"
                    log.info(
                        "sync cred_id=%s client_id=%s success=false trigger=%s error=%s",
                        cred_id,
                        client_id_for_log,
                        trigger,
                        err,
                    )
                    return CredentialSyncResult(
                        False, cred_id, client_id_for_log, err, sync_id, trigger, None
                    )
                touch_credential_last_successful_sync(sconn, cred_id)
                cred_out = get_credential_by_id(sconn, cred_id)

            log.info(
                "sync cred_id=%s client_id=%s success=true trigger=%s sync_id=%s",
                cred_id,
                client_id_for_log,
                trigger,
                sync_id or "",
            )
            return CredentialSyncResult(
                True,
                cred_id,
                client_id_for_log,
                None,
                sync_id,
                trigger,
                cred_out,
                sync_summary,
            )
        finally:
            _set_sync_activity(None, None, None)
