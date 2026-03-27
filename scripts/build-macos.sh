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
SCRIPTS="$ROOT/packaging/macos/scripts"
rm -rf "$STAGE"
mkdir -p "$STAGE/opt/SophosCentralGUI" "$PKG_DIR"
cp -R "$ROOT/dist/SophosCentralGUI/." "$STAGE/opt/SophosCentralGUI/"

# Finder /Applications launcher (.app wraps /opt one-folder binary)
APP_NAME="SFOS Central Firewall Management.app"
APP_DIR="$STAGE/Applications/$APP_NAME"
mkdir -p "$APP_DIR/Contents/MacOS"
cat >"$APP_DIR/Contents/MacOS/SophosCentralGUI" <<'EOS'
#!/bin/bash
exec /opt/SophosCentralGUI/SophosCentralGUI "$@"
EOS
chmod +x "$APP_DIR/Contents/MacOS/SophosCentralGUI"

cat >"$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>SophosCentralGUI</string>
  <key>CFBundleIdentifier</key>
  <string>com.sophos.central.gui</string>
  <key>CFBundleName</key>
  <string>SFOS Central Firewall Management</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
</dict>
</plist>
EOF

chmod +x "$SCRIPTS/postinstall"

PKG_PATH="$PKG_DIR/SophosCentralGUI-${VERSION}-macOS-$(uname -m).pkg"
pkgbuild \
  --root "$STAGE" \
  --identifier "com.sophos.central.gui" \
  --version "$VERSION" \
  --install-location "/" \
  --scripts "$SCRIPTS" \
  "$PKG_PATH"

echo "==> Package: $PKG_PATH"
echo "Install: sudo installer -pkg \"$(basename "$PKG_PATH")\" -target /"
echo "Launch: open -a \"$APP_NAME\" (installed under /Applications; runtime in /opt/SophosCentralGUI)"
