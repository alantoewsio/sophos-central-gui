#!/usr/bin/env bash
# Build a self-contained macOS app (PyInstaller) and an unsigned .pkg installer.
# Run on macOS with uv installed (https://github.com/astral-sh/uv).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Sync + PyInstaller"
uv sync --extra bundle
uv run pyinstaller --noconfirm SophosCentralGUI.spec

VERSION="$(uv run python -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")"
STAGE="$ROOT/packaging/stage/macos-root"
PKG_DIR="$ROOT/dist/installers"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$PKG_DIR"
cp -R "$ROOT/dist/SophosCentralGUI/." "$STAGE/"

PKG_PATH="$PKG_DIR/SophosCentralGUI-${VERSION}-macOS-$(uname -m).pkg"
pkgbuild \
  --root "$STAGE" \
  --identifier "com.sophos.central.gui" \
  --version "$VERSION" \
  --install-location "/opt/SophosCentralGUI" \
  "$PKG_PATH"

echo "==> Package: $PKG_PATH"
echo "Install: sudo installer -pkg \"$(basename "$PKG_PATH")\" -target /"
echo "Run: /opt/SophosCentralGUI/SophosCentralGUI (data under ~/Library/Application Support/SophosCentralGUI if /opt is not writable)"
