# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: one-folder bundle with embedded CPython runtime (no system Python)."""
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

block_cipher = None

_root = Path(SPECPATH)

datas = [
    (str(_root / "templates"), "templates"),
    (str(_root / "static"), "static"),
]
binaries = []
hiddenimports = [
    "main",
    "app_paths",
    "auth",
    "credential_store",
    "audit_log",
    "sync_runner",
    "sync_scheduler",
    "cli",
    "pydantic.deprecated.decorator",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

for pkg in (
    "uvicorn",
    "fastapi",
    "starlette",
    "pydantic",
    "cryptography",
    "jinja2",
    "multipart",
    "anyio",
    "httptools",
    "watchfiles",
    "websockets",
    "central",
    "requests",
    "certifi",
    "charset_normalizer",
    "idna",
    "urllib3",
    "argon2",
    "itsdangerous",
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# uvloop is Unix-only; optional on Windows
try:
    d, b, h = collect_all("uvloop")
    datas += d
    binaries += b
    hiddenimports += h
except Exception:
    pass

a = Analysis(
    [str(_root / "main.py")],
    pathex=[str(_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SophosCentralGUI",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="SophosCentralGUI",
)
