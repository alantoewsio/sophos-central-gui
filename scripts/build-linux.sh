#!/usr/bin/env bash
# Build a self-contained Linux app (PyInstaller) and a .deb package (no system Python).
# Run on Linux with: uv, dpkg-deb (dpkg package). For other arch, run on that arch or adjust below.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Sync + PyInstaller"
uv sync --extra bundle
uv run pyinstaller --noconfirm SophosCentralGUI.spec

VERSION="$(uv run python -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")"
DEB_ROOT="$ROOT/packaging/stage/deb"
rm -rf "$DEB_ROOT"
mkdir -p "$DEB_ROOT/DEBIAN" "$DEB_ROOT/opt/SophosCentralGUI" "$DEB_ROOT/usr/bin"

cp -R "$ROOT/dist/SophosCentralGUI/." "$DEB_ROOT/opt/SophosCentralGUI/"

ln -sf /opt/SophosCentralGUI/SophosCentralGUI "$DEB_ROOT/usr/bin/sophos-central-gui"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DEB_ARCH=amd64 ;;
  aarch64) DEB_ARCH=arm64 ;;
  *) DEB_ARCH="$ARCH" ;;
esac

cat > "$DEB_ROOT/DEBIAN/control" << EOF
Package: sophos-central-gui
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Sophos Central GUI <local@localhost>
Description: Web UI for Sophos Central (bundled runtime)
 Bundled CPython and dependencies; does not use the system Python install.
EOF

mkdir -p "$ROOT/dist/installers"
DEB_OUT="$ROOT/dist/installers/sophos-central-gui_${VERSION}_${DEB_ARCH}.deb"
dpkg-deb --root-owner-group -Zxz -z9 --build "$DEB_ROOT" "$DEB_OUT"

echo "==> Package: $DEB_OUT"
echo "Install: sudo apt install ./$(basename "$DEB_OUT")"
echo "Run: sophos-central-gui  (or /opt/SophosCentralGUI/SophosCentralGUI)"
