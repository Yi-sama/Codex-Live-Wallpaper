#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputPath
  #error OutputPath is required
#endif
#ifndef AppVersion
  #define AppVersion "0.3.6"
#endif

[Setup]
AppId={{B4D2D4A3-30BC-4793-8509-25D83AF3DBDE}
AppName=Codex Live Wallpaper
AppVersion={#AppVersion}
AppPublisher=Codex Live Wallpaper contributors
DefaultDirName={localappdata}\Programs\CodexLiveWallpaper
DefaultGroupName=Codex Live Wallpaper
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
OutputDir={#OutputPath}
OutputBaseFilename=CodexLiveWallpaper-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#PayloadDir}\plugins\dsh-plugin-wallpaper-engine-codex\LICENSE
CloseApplications=no
RestartApplications=no
UninstallDisplayName=Codex Live Wallpaper
SetupLogging=yes
AllowNoIcons=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "installer-actions.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\Codex Live Wallpaper"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\start-codex.ps1"""; WorkingDir: "{app}"
Name: "{userdesktop}\Codex Live Wallpaper"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\start-codex.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\start-codex.ps1"""; Description: "Launch Codex Live Wallpaper"; Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
Type: files; Name: "{app}\installation.json"
Type: files; Name: "{app}\.agents\plugins\marketplace.json"
Type: dirifempty; Name: "{app}\.agents\plugins"
Type: dirifempty; Name: "{app}\.agents"
Type: dirifempty; Name: "{app}"

[Code]
function ActionLogPath(Action: String): String;
var
  Directory: String;
begin
  Directory := ExpandConstant('{param:DIAGNOSTICSDIR|}');
  if Directory = '' then
    Directory := ExpandConstant('{localappdata}\CodexLiveWallpaper\logs');
  if not ForceDirectories(Directory) then
    Directory := ExpandConstant('{tmp}');
  Result := AddBackslash(Directory) + 'setup-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '-' + Action + '.txt';
end;

function RunActions(Script, Action: String; var LogPath: String): Boolean;
var
  ExitCode: Integer;
  Index: Integer;
  Args, Executable, Report, Failure: String;
  Detail: AnsiString;
  Started: Boolean;
  Output: TExecOutput;
begin
  Executable := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script +
    '" -Action ' + Action + ' -AppRoot "' + ExpandConstant('{app}') +
    '" -LogFile "' + LogPath + '"';
  ExitCode := -1;
  Started := False;
  Failure := '';
  Output.Error := False;
  try
    Started := ExecAndCaptureOutputWithNativeSysDir(Executable, Args, '',
      SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode, Output);
    if not Started then Failure := SysErrorMessage(ExitCode);
  except
    Failure := GetExceptionMessage;
  end;
  Result := Started and (ExitCode = 0) and not Output.Error;
  Report := 'Action: ' + Action + #13#10 + 'PowerShell: ' + Executable + #13#10 +
    'Script: ' + Script + #13#10 + 'Exit code: ' + IntToStr(ExitCode) + #13#10;
  if Failure <> '' then Report := Report + 'Process error: ' + Failure + #13#10;
  if Output.Error then Report := Report + 'Process output capture failed; read the setup log.' + #13#10;
  if LoadStringFromFile(LogPath, Detail) and (Trim(Utf8Decode(Detail)) <> '') then
    Report := Report + #13#10 + Utf8Decode(Detail) + #13#10
  else
    Report := Report + #13#10 + 'No action diagnostic was written; captured output follows.' + #13#10;
  Report := Report + #13#10 + 'Standard output:' + #13#10;
  for Index := 0 to GetArrayLength(Output.StdOut) - 1 do
    Report := Report + Output.StdOut[Index] + #13#10;
  Report := Report + #13#10 + 'Standard error:' + #13#10;
  for Index := 0 to GetArrayLength(Output.StdErr) - 1 do
    Report := Report + Output.StdErr[Index] + #13#10;
  if not SaveStringToFile(LogPath, UTF8Encode(Report), False) then begin
    LogPath := ExpandConstant('{tmp}\codex-wallpaper-' + Action + '.txt');
    if not SaveStringToFile(LogPath, UTF8Encode(Report), False) then
      RaiseException('Could not save installer diagnostics.' + #13#10 + Report);
  end;
  Log('Action diagnostic: ' + LogPath);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  LogPath: String;
  Detail: AnsiString;
begin
  Result := '';
  LogPath := ActionLogPath('Check');
  ExtractTemporaryFile('installer-actions.ps1');
  if not RunActions(ExpandConstant('{tmp}\installer-actions.ps1'), 'Check', LogPath) then begin
    LoadStringFromFile(LogPath, Detail);
    Result := 'Codex prerequisite check failed. Read the diagnostic below before changing your installation.' + #13#10 + Utf8Decode(Detail) + #13#10 + 'Diagnostic log: ' + LogPath;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogPath: String;
  Detail: AnsiString;
begin
  if CurStep = ssPostInstall then begin
    LogPath := ActionLogPath('Install');
    if not RunActions(ExpandConstant('{app}\installer-actions.ps1'), 'Install', LogPath) then begin
      LoadStringFromFile(LogPath, Detail);
      RaiseException('Plugin registration failed. Your Codex account and wallpaper files were not removed. Run setup again after resolving:' + #13#10 + Utf8Decode(Detail) + #13#10 + 'Diagnostic log: ' + LogPath);
    end;
  end;
end;

function InitializeUninstall: Boolean;
var
  LogPath: String;
  Detail: AnsiString;
begin
  LogPath := ActionLogPath('Uninstall');
  Result := RunActions(ExpandConstant('{app}\installer-actions.ps1'), 'Uninstall', LogPath);
  if not Result then begin
    LoadStringFromFile(LogPath, Detail);
    MsgBox('Could not remove the Codex plugin registration. No wallpaper data was deleted.' + #13#10 + Utf8Decode(Detail) + #13#10 + 'Diagnostic log: ' + LogPath, mbError, MB_OK);
  end;
end;
