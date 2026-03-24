"""Background thread: sync each Central credential when its interval elapses."""

from __future__ import annotations

import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone

from credential_store import CREDENTIAL_SYNC_INTERVAL_SECONDS, get_secrets_db, list_credentials
from sync_runner import configure_sync_file_logging, run_credential_sync

POLL_INTERVAL_SEC = 60


def _interval_seconds(raw: str | None) -> int | None:
    if raw is None:
        return None
    key = str(raw).strip()
    return CREDENTIAL_SYNC_INTERVAL_SECONDS.get(key)


def _parse_iso_utc(s: str | None) -> datetime | None:
    if not s or not str(s).strip():
        return None
    t = str(s).strip()
    try:
        d = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    else:
        d = d.astimezone(timezone.utc)
    return d


def _credential_due(
    *,
    last_sync_iso: str | None,
    interval_sec: int,
    now_utc: datetime,
) -> bool:
    last = _parse_iso_utc(last_sync_iso)
    if last is None:
        return True
    elapsed = (now_utc - last).total_seconds()
    return elapsed >= interval_sec


def scheduler_loop(stop_event: threading.Event | None = None) -> None:
    log = configure_sync_file_logging()
    # Short jitter only: avoids every credential syncing on the same second at process
    # start. A long random delay would leave "next sync" overdue in the UI for hours.
    first_delay = secrets.randbelow(POLL_INTERVAL_SEC) if POLL_INTERVAL_SEC > 0 else 0
    log.info(
        "scheduler_start first_jitter_seconds=%s poll_interval_seconds=%s",
        first_delay,
        POLL_INTERVAL_SEC,
    )
    time.sleep(first_delay)
    while True:
        if stop_event is not None and stop_event.is_set():
            return
        try:
            _scheduler_tick()
        except Exception as e:
            log.info("scheduler_tick_error error=%s", str(e).replace("\n", " "))
        for _ in range(POLL_INTERVAL_SEC):
            if stop_event is not None and stop_event.is_set():
                return
            time.sleep(1)


def _scheduler_tick() -> None:
    now_utc = datetime.now(timezone.utc)
    with get_secrets_db() as sconn:
        creds = list_credentials(sconn)
    for c in creds:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        interval_sec = _interval_seconds(c.get("sync_interval"))
        if interval_sec is None:
            continue
        last_sync = c.get("last_sync")
        if isinstance(last_sync, str):
            pass
        elif last_sync is not None:
            last_sync = str(last_sync)
        else:
            last_sync = None
        if not _credential_due(last_sync_iso=last_sync, interval_sec=interval_sec, now_utc=now_utc):
            continue
        try:
            from main import get_db

            with get_db() as central_conn:
                run_credential_sync(cid, central_conn=central_conn, trigger="scheduler")
        except sqlite3.Error as e:
            configure_sync_file_logging().info(
                "sync cred_id=%s client_id=%s success=false trigger=scheduler error=%s",
                cid,
                str(c.get("client_id") or "").strip(),
                str(e).replace("\n", " "),
            )


def start_scheduler_thread() -> None:
    t = threading.Thread(target=scheduler_loop, kwargs={"stop_event": None}, daemon=True, name="central-sync")
    t.start()
