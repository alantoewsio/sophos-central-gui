# Build a self-contained Windows app (PyInstaller) and optionally an Inno Setup installer.
# Requires: uv (https://github.com/astral-sh/uv). Optional: Inno Setup 6 (iscc.exe on PATH).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> Sync + PyInstaller (from $Root)"
uv sync --extra bundle
uv run pyinstaller --noconfirm SophosCentralGUI.spec

$isccPath = $null
$cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($cmd) {
    $isccPath = $cmd.Source
}
if (-not $isccPath) {
    foreach ($p in @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) {
            $isccPath = $p
            break
        }
    }
}
if ($isccPath) {
    Write-Host "==> Inno Setup: $isccPath"
    & $isccPath (Join-Path $Root "packaging\windows\SophosCentralGUI.iss")
    Write-Host "Installer: dist\installers\"
} else {
    Write-Host "Inno Setup (ISCC.exe) not found — ship dist\SophosCentralGUI\ as a folder or ZIP, or install Inno Setup and re-run."
}
