"""Detect git + repo, optional scheduled fetch/pull for development trees."""

from __future__ import annotations

import os
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from app_paths import bundle_root
from sync_runner import configure_sync_file_logging

GIT_AUTO_UPDATE_INTERVAL_CHOICES: tuple[str, ...] = (
    "never",
    "15m",
    "30m",
    "1h",
    "6h",
    "12h",
    "24h",
    "3d",
    "7d",
    "14d",
    "30d",
)

GIT_AUTO_UPDATE_INTERVAL_SECONDS: dict[str, int] = {
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "6h": 6 * 60 * 60,
    "12h": 12 * 60 * 60,
    "24h": 24 * 60 * 60,
    "3d": 3 * 24 * 60 * 60,
    "7d": 7 * 24 * 60 * 60,
    "14d": 14 * 24 * 60 * 60,
    "30d": 30 * 24 * 60 * 60,
}

GIT_UPDATE_POLL_INTERVAL_SEC = 60
_GIT_CMD_TIMEOUT_SEC = 120


def git_executable() -> str | None:
    return shutil.which("git")


def git_repo_root() -> Path | None:
    root = bundle_root()
    git_dir = root / ".git"
    if git_dir.is_dir() or git_dir.is_file():
        return root
    return None


def git_update_environment_available() -> bool:
    return bool(git_executable() and git_repo_root())


def git_update_page_visible() -> bool:
    """Sidebar entry: git on PATH and bundle root is a git working tree."""
    return git_update_environment_available()


def normalize_git_auto_update_interval(raw: str | None) -> str:
    k = (raw if raw is not None else "").strip()
    if k in GIT_AUTO_UPDATE_INTERVAL_SECONDS or k == "never":
        return k
    return "1h"


def git_auto_update_interval_seconds(key: str) -> int | None:
    k = normalize_git_auto_update_interval(key)
    if k == "never":
        return None
    return GIT_AUTO_UPDATE_INTERVAL_SECONDS.get(k)


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


def _check_due(*, last_iso: str | None, interval_sec: int, now_utc: datetime) -> bool:
    last = _parse_iso_utc(last_iso)
    if last is None:
        return True
    return (now_utc - last).total_seconds() >= interval_sec


def _run_git(repo: Path, args: list[str], *, timeout: int = _GIT_CMD_TIMEOUT_SEC) -> subprocess.CompletedProcess[str]:
    exe = git_executable()
    assert exe
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(
        [exe, "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def perform_git_auto_update(repo: Path | None = None) -> str:
    """
    Fetch, compare to upstream, fast-forward pull if behind.
    Returns a short human-readable status line.
    """
    r = repo or git_repo_root()
    if not r:
        return "Not a git checkout at app root"
    if not git_executable():
        return "Git executable not found"
    try:
        fr = _run_git(r, ["fetch", "--quiet"])
        if fr.returncode != 0:
            err = (fr.stderr or fr.stdout or "").strip()
            return f"Fetch failed: {(err[:240] + '…') if len(err) > 240 else err or fr.returncode}"

        ur = _run_git(r, ["rev-parse", "--verify", "@{upstream}"])
        if ur.returncode != 0:
            return "No upstream tracking branch"

        cr = _run_git(r, ["rev-list", "--count", "HEAD..@{upstream}"])
        if cr.returncode != 0:
            return "Could not compare local HEAD to upstream"
        try:
            behind = int((cr.stdout or "0").strip() or "0")
        except ValueError:
            return "Could not read revision count"

        if behind == 0:
            return "Up to date"

        pr = _run_git(r, ["pull", "--ff-only"], timeout=180)
        if pr.returncode != 0:
            err = (pr.stderr or pr.stdout or "").strip()
            return f"Pull failed (use a clean tree or merge manually): {(err[:200] + '…') if len(err) > 200 else err or pr.returncode}"
        return f"Fast-forwarded ({behind} commit(s))"
    except subprocess.TimeoutExpired:
        return "Git command timed out"
    except OSError as e:
        return f"Git error: {e}"


def _clip_message(msg: str, max_len: int = 400) -> str:
    s = str(msg).replace("\n", " ").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def _scheduler_tick() -> None:
    if not git_update_environment_available():
        return
    repo = git_repo_root()
    if not repo:
        return
    log = configure_sync_file_logging()
    try:
        from main import DB_PATH, ensure_app_ui_schema, get_db
    except Exception as e:
        log.info("git_update_scheduler_import_error error=%s", str(e).replace("\n", " "))
        return

    if not DB_PATH.exists():
        return

    interval_key: str | None = None
    last_check: str | None = None
    try:
        with get_db() as conn:
            ensure_app_ui_schema(conn)
            row = conn.execute(
                "SELECT git_auto_update_interval, git_auto_update_last_check_at "
                "FROM app_ui_settings WHERE id = 1"
            ).fetchone()
            if not row:
                return
            interval_key = normalize_git_auto_update_interval(row["git_auto_update_interval"])
            last_check = row["git_auto_update_last_check_at"]
    except sqlite3.Error as e:
        log.info("git_update_scheduler_db_read_error error=%s", str(e).replace("\n", " "))
        return

    iv = git_auto_update_interval_seconds(interval_key or "1h")
    if iv is None:
        return

    now_utc = datetime.now(timezone.utc)
    if not _check_due(last_iso=last_check, interval_sec=iv, now_utc=now_utc):
        return

    msg = perform_git_auto_update(repo)
    log.info("git_auto_update result=%s", _clip_message(msg, 300))
    now_iso = now_utc.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        with get_db() as conn:
            ensure_app_ui_schema(conn)
            conn.execute(
                """
                UPDATE app_ui_settings SET
                  git_auto_update_last_check_at = ?,
                  git_auto_update_last_message = ?
                WHERE id = 1
                """,
                (now_iso, _clip_message(msg)),
            )
            conn.commit()
    except sqlite3.Error as e:
        log.info("git_update_scheduler_db_write_error error=%s", str(e).replace("\n", " "))


def git_update_scheduler_loop(stop_event: threading.Event | None = None) -> None:
    log = configure_sync_file_logging()
    jitter = secrets.randbelow(GIT_UPDATE_POLL_INTERVAL_SEC) if GIT_UPDATE_POLL_INTERVAL_SEC > 0 else 0
    log.info(
        "git_update_scheduler_start first_jitter_seconds=%s poll_interval_seconds=%s",
        jitter,
        GIT_UPDATE_POLL_INTERVAL_SEC,
    )
    time.sleep(jitter)
    while True:
        if stop_event is not None and stop_event.is_set():
            return
        try:
            _scheduler_tick()
        except Exception as e:
            log.info("git_update_tick_error error=%s", str(e).replace("\n", " "))
        for _ in range(GIT_UPDATE_POLL_INTERVAL_SEC):
            if stop_event is not None and stop_event.is_set():
                return
            time.sleep(1)


def start_git_update_scheduler_thread() -> None:
    t = threading.Thread(
        target=git_update_scheduler_loop,
        kwargs={"stop_event": None},
        daemon=True,
        name="git-auto-update",
    )
    t.start()
