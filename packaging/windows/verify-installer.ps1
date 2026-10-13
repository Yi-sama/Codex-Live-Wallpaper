param(
  [Parameter(Mandatory)]
  [string]$InstallerPath,
  [Parameter(Mandatory)]
  [string]$WorkRoot,
  [switch]$VerifyIcons
)

$ErrorActionPreference = 'Stop'
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
$testRoot = Join-Path $WorkRoot ("verify-" + [guid]::NewGuid().ToString('N'))
$appRoot = Join-Path $testRoot 'app with spaces'
$profile = Join-Path $testRoot 'isolated-codex'
$data = Join-Path $testRoot 'wallpaper-data'
$registrationKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B4D2D4A3-30BC-4793-8509-25D83AF3DBDE}_is1'
if (Test-Path -LiteralPath $registrationKey) { throw 'An EXE installation already exists for this user. Do not replace it during verification.' }
if (-not $appRoot.StartsWith($WorkRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test installation is outside the intended workspace.' }
New-Item -ItemType Directory -Force -Path $testRoot, $profile | Out-Null
$oldHome = $env:CODEX_HOME
$oldData = $env:CODEX_SKIN_DATA_DIR
$oldPath = $env:PATH
$oldLocalAppData = $env:LOCALAPPDATA
$oldCliPath = $env:CODEX_CLI_PATH
$cliHandle = $null
$cli = if ($oldCliPath) { $oldCliPath } else { (Get-Command codex.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'The test Codex CLI does not exist.' }
$env:CODEX_CLI_PATH = $cli
$checks = [ordered]@{ testRoot = $testRoot }
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Live Wallpaper.lnk'
$hadDesktopShortcut = Test-Path -LiteralPath $desktop
$testGroupName = 'Codex Live Wallpaper Verify ' + [IO.Path]::GetFileName($testRoot)
$testGroup = Join-Path ([Environment]::GetFolderPath('Programs')) $testGroupName
if ($VerifyIcons -and ($hadDesktopShortcut -or (Test-Path -LiteralPath $testGroup))) {
  throw 'Icon verification refuses to replace existing shortcuts.'
}

function Run-Setup {
  param([string]$LogName)
  $arguments = @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    "/DIAGNOSTICSDIR=`"$(Join-Path $testRoot 'diagnostics')`"",
    "/DIR=`"$appRoot`"", "/LOG=`"$(Join-Path $testRoot $LogName)`""
  )
  if ($VerifyIcons) { $arguments += @('/TASKS=desktopicon', "/GROUP=`"$testGroupName`"") }
  else { $arguments += @('/NOICONS', '/TASKS=') }
  $process = Start-Process -FilePath $InstallerPath -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode). Read $LogName under $testRoot." }
}

try {
  $env:CODEX_HOME = $profile
  $env:CODEX_SKIN_DATA_DIR = $data
  $env:LOCALAPPDATA = Join-Path $testRoot 'local'
  New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null
  $env:PATH = "$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\WindowsPowerShell\v1.0"
  if (Get-Command node -ErrorAction SilentlyContinue) { throw 'Global Node is still available in the test process.' }
  Run-Setup -LogName 'install.log'
  $recordFile = Join-Path $appRoot 'installation.json'
  $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $record.registered -or $record.codexHome -ne $profile -or $record.dataDir -ne $data) { throw 'Installation metadata did not use the isolated profile and data paths.' }
  $checks.install = 'pass'
  $uninstaller = Join-Path $appRoot 'unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf) -or (Get-Item -LiteralPath $uninstaller).Length -lt 100KB) {
    throw 'The installation directory does not contain the standalone uninstaller EXE.'
  }
  $checks.uninstallerExe = $uninstaller
  $build = Get-Content -LiteralPath (Join-Path $appRoot 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $installedPackage = Get-Content -LiteralPath (Join-Path $record.pluginRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $installedManifest = Get-Content -LiteralPath (Join-Path $record.pluginRoot '.codex-plugin\plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $registration = Get-ItemProperty -LiteralPath $registrationKey
  if ($build.version -ne $installedPackage.version -or $build.pluginVersion -ne $installedManifest.version -or $registration.DisplayVersion -ne $build.version) {
    throw 'Installer, package, plugin and Windows registration versions disagree.'
  }
  $checks.version = $build.version
  $iconPath = Join-Path $appRoot 'setup-icon.ico'
  $sourceIcon = Join-Path $PSScriptRoot 'assets\setup-icon.ico'
  if ((Get-FileHash -LiteralPath $iconPath).Hash -ne (Get-FileHash -LiteralPath $sourceIcon).Hash) {
    throw 'The installed icon does not match the source asset.'
  }
  if ($registration.DisplayIcon -ne $iconPath) { throw 'Windows uninstall display does not use the shipped icon.' }
  Add-Type -AssemblyName System.Drawing
  $exeIcon = [Drawing.Icon]::ExtractAssociatedIcon($InstallerPath)
  if (-not $exeIcon) { throw 'The installer has no extractable icon.' }
  $bitmap = $exeIcon.ToBitmap()
  try {
    $bitmap.Save((Join-Path $testRoot 'installer-icon.png'), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose(); $exeIcon.Dispose() }
  $checks.installerIcon = 'extracted'
  $checks.installedIconHash = (Get-FileHash -LiteralPath $iconPath).Hash
  if ($VerifyIcons) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in @($desktop, (Join-Path $testGroup 'Codex Live Wallpaper.lnk'), (Join-Path $testGroup 'Uninstall Codex Live Wallpaper.lnk'))) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "The installer did not create the expected shortcut: $path" }
      $shortcut = $shell.CreateShortcut($path)
      $expectedIcon = $iconPath + ',0'
      if ($shortcut.IconLocation -ne $expectedIcon) { throw "Shortcut icon differs from the shipped icon: $path" }
      if ($path.EndsWith('Uninstall Codex Live Wallpaper.lnk')) {
        if ($shortcut.TargetPath -ne $uninstaller) { throw 'Uninstall shortcut does not target the local uninstaller.' }
      } elseif (-not $shortcut.Arguments.Contains((Join-Path $appRoot 'start-codex.ps1'))) {
        throw 'Launcher shortcut does not target the isolated installation.'
      }
    }
    $checks.shortcuts = 'desktop, Start menu launcher and uninstaller passed'
  }
  $nodeVersion = & $record.nodePath --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.14.0') { throw 'Bundled Node did not execute.' }
  $checks.bundledNode = $nodeVersion
  $listed = & $cli plugin list --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not @($listed.installed | Where-Object { $_.pluginId -eq 'dsh-plugin-wallpaper-engine-codex@codex-live-wallpaper' -and $_.enabled }).Count) { throw 'Plugin is not installed/enabled in the isolated Codex profile.' }
  $mcp = Get-Content -LiteralPath (Join-Path $record.pluginRoot '.mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($mcp.mcpServers.codex_skin.command -ne $record.nodePath -or $mcp.mcpServers.codex_skin.env.CODEX_SKIN_DATA_DIR -ne $data) { throw 'MCP paths do not match the bundled runtime and data directory.' }
  $checks.registration = 'pass'
  $server = $mcp.mcpServers.codex_skin
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $server.command
  $info.Arguments = '"' + $server.args[0] + '"'
  $info.WorkingDirectory = $server.cwd
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($entry in $server.env.PSObject.Properties) { $info.EnvironmentVariables[$entry.Name] = [string]$entry.Value }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw 'Installed MCP server could not start.' }
    $stderr = $process.StandardError.ReadToEndAsync()
    foreach ($request in @(
      @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'installer-verification'; version = '1.0' } } },
      @{ jsonrpc = '2.0'; id = 2; method = 'tools/list' }
    )) {
      $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 10 -Compress))
      $line = $process.StandardOutput.ReadLineAsync()
      if (-not $line.Wait(10000)) { throw "MCP request timed out: $($request.method)" }
      $reply = $line.Result | ConvertFrom-Json
      if ($reply.id -ne $request.id -or $reply.error -or -not $reply.result) { throw "MCP returned an invalid response: $($request.method)" }
      if ($request.method -eq 'initialize' -and $reply.result.serverInfo.version -ne $build.version) {
        throw 'Installed MCP version does not match the installer.'
      }
    }
    foreach ($name in @('codex_skin_status', 'codex_skin_list_sources', 'codex_skin_apply', 'codex_skin_remove')) {
      if ($name -notin $reply.result.tools.name) { throw "Installed MCP tool is missing: $name" }
    }
    $apply = $reply.result.tools | Where-Object { $_.name -eq 'codex_skin_apply' }
    foreach ($name in @('panelOpacity', 'scrimOpacity', 'blurPx', 'muted', 'volume')) {
      $property = $apply.inputSchema.properties.$name
      if (-not $property -or $property.PSObject.Properties['default']) {
        throw "Installed MCP must preserve saved settings when '$name' is omitted."
      }
    }
    $checks.partialApplySchema = 'pass'
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Installed MCP server did not close successfully.' }
    $checks.mcp = 'pass'
  } finally {
    if ($process.Id -and -not $process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
  # Read-only validation needs the real app location, but all writable paths remain explicit and isolated.
  $isolatedLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $oldLocalAppData
    $validation = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $appRoot 'start-codex.ps1') -ValidateOnly 2>&1
    if ($LASTEXITCODE -ne 0 -or -not ($validation -match 'Launcher validation passed')) {
      throw "Installed launcher validation failed.`n$($validation -join "`n")"
    }
  } finally { $env:LOCALAPPDATA = $isolatedLocalAppData }
  $checks.launcher = 'pass'
  $diagnostics = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'diagnostics') -Filter '*.txt')
  if ($diagnostics.Count -lt 2) { throw 'The installer did not persist Check/Install diagnostics.' }
  foreach ($file in $diagnostics) {
    $text = [IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false, $true))
    if (-not $text.Contains('Exit code: 0') -or -not $text.Contains('Standard error:')) { throw "Incomplete process diagnostic: $($file.FullName)" }
  }
  $checks.diagnostics = 'pass'
  $runtimeRoot = Join-Path $env:LOCALAPPDATA 'CodexLiveWallpaper\runtime\codex-cli'
  if (Test-Path -LiteralPath $runtimeRoot) {
    $bundles = @(Get-ChildItem -LiteralPath $runtimeRoot -Directory)
    if ($bundles.Count -ne 1) { throw 'Check and Install did not reuse the same private CLI bundle.' }
    $privateCli = Join-Path $bundles[0].FullName 'codex.exe'
    $privateHash = (Get-FileHash -LiteralPath $privateCli).Hash
    $cliHandle = [IO.File]::Open($privateCli, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  }
  $state = Join-Path $data 'state.json'
  [IO.File]::WriteAllText($state, '{"enabled":false,"installerTest":"keep"}', [Text.UTF8Encoding]::new($false))
  $stateHash = (Get-FileHash -LiteralPath $state).Hash
  $cacheFile = Join-Path $data 'test-cache.mp4'
  $accountFile = Join-Path $profile 'auth.json'
  [IO.File]::WriteAllText($cacheFile, 'isolated cache fixture', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($accountFile, '{"installerTest":"keep; not real credentials"}', [Text.UTF8Encoding]::new($false))
  $cacheHash = (Get-FileHash -LiteralPath $cacheFile).Hash
  $accountHash = (Get-FileHash -LiteralPath $accountFile).Hash
  $env:CODEX_SKIN_DATA_DIR = Join-Path $testRoot 'different-data'
  Run-Setup -LogName 'reinstall.log'
  $again = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($again.dataDir -ne $data -or $again.codexHome -ne $profile -or (Get-FileHash -LiteralPath $state).Hash -ne $stateHash) { throw 'Reinstallation changed the saved profile, data path or settings.' }
  $checks.reinstall = 'pass'
  if (-not $uninstaller.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing an uninstaller outside the test directory.' }
  $process = Start-Process -FilePath $uninstaller -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $testRoot 'uninstall.log')`""
    "/DIAGNOSTICSDIR=`"$(Join-Path $testRoot 'diagnostics')`""
  )
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
  if ((Get-FileHash -LiteralPath $state).Hash -ne $stateHash) { throw 'Uninstall removed or changed wallpaper data.' }
  if ((Get-FileHash -LiteralPath $cacheFile).Hash -ne $cacheHash) { throw 'Uninstall removed or changed wallpaper caches.' }
  if ((Get-FileHash -LiteralPath $accountFile).Hash -ne $accountHash) { throw 'Uninstall removed or changed Codex account files.' }
  if (Test-Path -LiteralPath $registrationKey) { throw 'The uninstall registration was not removed.' }
  $listed = & $cli plugin list --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or @($listed.installed | Where-Object { $_.pluginId -eq 'dsh-plugin-wallpaper-engine-codex@codex-live-wallpaper' }).Count) { throw 'The plugin is still registered after uninstall.' }
  if (Test-Path -LiteralPath $appRoot) { throw 'The test application directory remains after uninstall.' }
  if (-not $hadDesktopShortcut -and (Test-Path -LiteralPath $desktop)) { throw 'Silent testing created an unexpected desktop shortcut.' }
  if ($VerifyIcons -and (Test-Path -LiteralPath $testGroup)) { throw 'The test Start menu group remains after uninstall.' }
  $checks.uninstall = 'pass'
  $checks.dataRetained = 'pass'
  $checks.cacheRetained = 'pass'
  $checks.accountRetained = 'pass'
  if ($cliHandle) {
    if ((Get-FileHash -LiteralPath $privateCli).Hash -ne $privateHash -or @(Get-ChildItem -LiteralPath $runtimeRoot -Directory).Count -ne 1) {
      throw 'Reinstall/uninstall changed the occupied reusable CLI bundle.'
    }
    $checks.occupiedCliRetained = 'pass'
  }
  $checks | ConvertTo-Json
} finally {
  if ($cliHandle) { $cliHandle.Dispose() }
  $env:CODEX_HOME = $oldHome
  $env:CODEX_SKIN_DATA_DIR = $oldData
  $env:PATH = $oldPath
  $env:LOCALAPPDATA = $oldLocalAppData
  $env:CODEX_CLI_PATH = $oldCliPath
  [IO.File]::WriteAllText((Join-Path $testRoot 'report.json'), ($checks | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
}
