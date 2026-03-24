"""Resolve read-only bundle paths vs writable runtime paths (PyInstaller / dev)."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False)) and hasattr(sys, "_MEIPASS")


def bundle_root() -> Path:
    """Templates, static assets, and other files shipped inside the bundle."""
    if _is_frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def _probe_writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".sophos_central_gui_write_probe"
        probe.write_text("1", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def _default_user_data_dir() -> Path:
    """When the install folder is not writable (e.g. Program Files), store data here."""
    home = Path.home()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "SophosCentralGUI"
        return home / "AppData" / "Local" / "SophosCentralGUI"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "SophosCentralGUI"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "sophos-central-gui"
    return home / ".local" / "share" / "sophos-central-gui"


def runtime_root() -> Path:
    """Databases, logs, session secret, Fernet key — beside the exe when writable, else user data dir."""
    if not _is_frozen():
        return Path(__file__).resolve().parent
    beside = Path(sys.executable).resolve().parent
    if _probe_writable_dir(beside):
        return beside
    data = _default_user_data_dir()
    data.mkdir(parents=True, exist_ok=True)
    return data
