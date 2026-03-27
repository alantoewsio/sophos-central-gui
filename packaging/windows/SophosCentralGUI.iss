; Inno Setup 6 (https://jrsoftware.org/isinfo.php) — compile on Windows after PyInstaller build.
; Install tree is fully self-contained (embedded Python); no dependency on system Python.

#define MyAppName "SFOS Central Firewall Management"
#define MyAppVersion "0.1.6"
#define MyAppPublisher "SFOS Central Firewall Management"
#define MyAppExeName "SophosCentralGUI.exe"
#define BundledDist "..\..\dist\SophosCentralGUI"

[Setup]
AppId={{E7B3A1C2-9D4F-5E6A-B8C0-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install (no admin): install dir stays writable so DB/logs can live beside the exe.
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\installers
OutputBaseFilename=SophosCentralGUI-{#MyAppVersion}-Windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "Start {#MyAppName} when Windows starts"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "launchnow"; Description: "Launch {#MyAppName} when installation finishes"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "{#BundledDist}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: startup

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent; Tasks: launchnow
