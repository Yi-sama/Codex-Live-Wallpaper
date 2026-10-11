param(
  [ValidateScript({ $_ -eq 0 -or ($_ -ge 1024 -and $_ -le 65535) })]
  [int]$Port = 0,
  [ValidateRange(1, 300)]
  [int]$StartupTimeoutSeconds = 90,
  [string]$DataDir,
  [string]$NodePath,
  [string]$CodexHome,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$env:CODEX_HOME = if ($CodexHome) { [IO.Path]::GetFullPath($CodexHome) } else { Join-Path $env:USERPROFILE '.codex' }
$env:CODEX_SKIN_DATA_DIR = if ($DataDir) { [IO.Path]::GetFullPath($DataDir) } elseif ($env:CODEX_SKIN_DATA_DIR) { $env:CODEX_SKIN_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexWallpaperEngineSkin' }
Add-Type -AssemblyName System.Net.Http

function Write-LauncherLog {
  param([string]$Text)
  New-Item -ItemType Directory -Force -Path $env:CODEX_SKIN_DATA_DIR | Out-Null
  Add-Content -LiteralPath (Join-Path $env:CODEX_SKIN_DATA_DIR 'launcher.log') `
    -Value "$([DateTime]::Now.ToString('s')) $Text" -Encoding UTF8
}

function Find-CodexDebugEndpoint {
  param([int]$DebugPort)
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(1)
  $failures = @()
  try {
    foreach ($address in @('127.0.0.1', '[::1]')) {
      $uri = "http://${address}:$DebugPort/json"
      try {
        $targets = $client.GetStringAsync($uri).GetAwaiter().GetResult() | ConvertFrom-Json
        $allowed = @($targets | Where-Object {
          $_.type -eq 'page' -and $_.url -ceq 'app://-/index.html' -and $_.webSocketDebuggerUrl
        })
        if ($allowed.Count -gt 0) {
          $script:lastDebugFailure = $null
          return $uri
        }
        $pages = @($targets | ForEach-Object {
          $url = $null
          if ([uri]::TryCreate([string]$_.url, [UriKind]::Absolute, [ref]$url)) {
            "$($_.type) $($url.GetLeftPart([UriPartial]::Path))"
          } else { "$($_.type) (URL unavailable)" }
        })
        $failures += "No allowed Codex page at $uri. Targets: $($pages -join ', ')"
      } catch {
        $details = @()
        for ($exception = $_.Exception; $exception; $exception = $exception.InnerException) {
          $details += "$($exception.GetType().FullName) [$($exception.HResult.ToString('X8'))]: $($exception.Message)"
        }
        $failures += "$uri : $($details -join ' -> ')"
      }
    }
    $script:lastDebugFailure = $failures -join "`n"
    return $null
  } finally {
    $client.Dispose()
  }
}

function Assert-DebugPortAvailable {
  param([int]$DebugPort)
  foreach ($address in @('127.0.0.1', '::1')) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($address), $DebugPort)
    $listener.Server.ExclusiveAddressUse = $true
    try {
      $listener.Start()
    } catch {
      throw "Debug port $DebugPort cannot bind on $address. $($_.Exception.Message) Use a free -Port and set CODEX_SKIN_CDP_PORT to the same port in the plugin configuration."
    } finally {
      $listener.Stop()
    }
  }
}

function Read-LaunchedDebugPort {
  param([string]$DebugLog)
  if (-not (Test-Path -LiteralPath $DebugLog)) { return $null }
  $text = [string](Get-Content -LiteralPath $DebugLog -Raw -Encoding UTF8 -ErrorAction Stop)
  $match = [regex]::Match($text, '(?m)^\s*DevTools listening on ws://(?:127\.0\.0\.1|\[::1\]|localhost):(?<port>[0-9]{1,5})/devtools/browser/[^\s]+\s*$')
  if ($match.Success) {
    $actualPort = [int]$match.Groups['port'].Value
    if ($actualPort -ge 1 -and $actualPort -le 65535) { return $actualPort }
  }
  return $null
}

function Write-DebugEndpointRecord {
  param([int]$ActualPort, [int]$ProcessId = 0)
  $file = Join-Path $env:CODEX_SKIN_DATA_DIR 'debug-endpoint.json'
  $partial = "$file.$PID.partial"
  $record = @{ port = $ActualPort; processId = $ProcessId; updatedAt = [DateTime]::UtcNow.ToString('o') }
  $json = $record | ConvertTo-Json
  [System.IO.File]::WriteAllText($partial, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $partial -Destination $file -Force
}

function Wait-CodexDebugEndpoint {
  param([int]$DebugPort, [int]$TimeoutSeconds = 90, [string]$DebugLog, [int]$ProcessId = 0)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $script:lastDebugFailure = $null
  do {
    if ($ProcessId) {
      $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
      if (-not $process -or $process.HasExited) {
        throw "Codex process $ProcessId exited before its wallpaper debug endpoint was ready. $script:lastDebugFailure Debug output: $DebugLog"
      }
    }
    $actualPort = $DebugPort
    if ($actualPort -eq 0) { $actualPort = Read-LaunchedDebugPort -DebugLog $DebugLog }
    if ($actualPort) {
      $endpoint = Find-CodexDebugEndpoint -DebugPort $actualPort
      if ($endpoint) { return $endpoint }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Codex started, but its wallpaper debug endpoint was not ready within $TimeoutSeconds seconds (requested port $DebugPort; detected port $actualPort). $script:lastDebugFailure Debug output: $DebugLog"
}

function Show-LauncherMessage {
  param(
    [string]$Text,
    [string]$Title = 'Codex Wallpaper Skin',
    [System.Windows.MessageBoxButton]$Buttons = [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]$Icon = [System.Windows.MessageBoxImage]::Information
  )
  return [System.Windows.MessageBox]::Show($Text, $Title, $Buttons, $Icon)
}

function Find-CodexExecutable {
  $candidates = @()
  $roots = @()
  $script:codexStorePackage = $null
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
  if ($package) {
    $packageRoot = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\') + '\'
    $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
      [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
      $application = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application' and @Id='App']")
      if ($application.Executable) {
        $declared = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $application.Executable))
        if (-not $declared.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase)) {
          throw 'The Codex manifest executable is outside its package directory.'
        }
        $candidates += $declared
      }
    }
    $roots += Join-Path $package.InstallLocation 'app'
    $roots += $package.InstallLocation
  }

  $codex = Get-Command codex -ErrorAction SilentlyContinue
  foreach ($cli in @($env:CODEX_CLI_PATH, $codex.Source)) {
    if (-not $cli) { continue }
    $resources = Split-Path -Parent $cli
    if ((Split-Path -Leaf $resources) -eq 'bin') { $resources = Split-Path -Parent $resources }
    if ((Split-Path -Leaf $resources) -eq 'resources') { $roots += Split-Path -Parent $resources }
  }

  $roots += Join-Path $env:LOCALAPPDATA 'Programs\Codex'
  $roots += Join-Path $env:ProgramFiles 'Codex'
  foreach ($root in ($roots | Select-Object -Unique)) {
    $candidates += Join-Path $root 'ChatGPT.exe'
    $candidates += Join-Path $root 'Codex.exe'
  }
  $script:checkedCodexExecutables = @($candidates | Select-Object -Unique)
  $selected = $script:checkedCodexExecutables | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($package -and $selected -and $selected.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $script:codexStorePackage = $package
  }
  return $selected
}

function Get-CodexProcesses {
  param([string]$Executable)
  $name = [IO.Path]::GetFileNameWithoutExtension($Executable)
  Get-Process | Where-Object {
    $_.ProcessName -eq $name -and $_.Path -eq $Executable
  }
}

function Start-CodexDesktop {
  param([string]$Executable, [string[]]$Arguments, [string]$DebugLog)
  if (-not $script:codexStorePackage) {
    if ($Executable -match '\\Program Files\\WindowsApps\\') {
      throw "Cannot launch an unregistered Store executable: $Executable"
    }
    return Start-Process -FilePath $executable -ArgumentList $Arguments -RedirectStandardError $DebugLog -PassThru
  }
  if (-not $script:codexStorePackage.PackageFamilyName) { throw 'The Store package family name is missing.' }

  # The helper keeps package identity and explicit profile paths while redirecting the app's stderr.
  $reportPath = "$DebugLog.start.json"
  $config = @{
    executable = $Executable; arguments = $Arguments; debugLog = $DebugLog; reportPath = $reportPath
    codexHome = $env:CODEX_HOME; dataDir = $env:CODEX_SKIN_DATA_DIR
  } | ConvertTo-Json -Depth 4 -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  $child = @'
$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PAYLOAD')) | ConvertFrom-Json
$env:CODEX_HOME = $config.codexHome
$env:CODEX_SKIN_DATA_DIR = $config.dataDir
try {
  $process = Start-Process -FilePath $config.executable -ArgumentList $config.arguments -RedirectStandardError $config.debugLog -PassThru
  $result = @{ success = $true; processId = $process.Id }
} catch {
  $result = @{ success = $false; error = $_.Exception.ToString(); hresult = $_.Exception.HResult.ToString('X8') }
}
[IO.File]::WriteAllText(($config.reportPath + '.partial'), ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[IO.File]::Move(($config.reportPath + '.partial'), $config.reportPath)
if (-not $result.success) { exit 1 }
'@.Replace('PAYLOAD', $payload)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
  $shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Invoke-CommandInDesktopPackage -PackageFamilyName $script:codexStorePackage.PackageFamilyName -AppId 'App' `
    -Command $shell -Args "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -PreventBreakaway | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $reportPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $reportPath)) { throw "The Store launch helper did not report its result: $reportPath" }
  $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $report.success) { throw "Store GUI launch failed for '$Executable' (HRESULT $($report.hresult)): $($report.error)`nLaunch report: $reportPath" }
  return [pscustomobject]@{ Id = [int]$report.processId }
}

$stage = 'resolve-executable'
try {
  $executable = Find-CodexExecutable
  if (-not $executable) {
    throw "The installed Codex executable was not found. Checked:`n$($script:checkedCodexExecutables -join "`n")"
  }
  $stage = 'validate-launcher'
  $running = @(Get-CodexProcesses -Executable $executable)
  if ($script:codexStorePackage -and -not (Get-Command Invoke-CommandInDesktopPackage -ErrorAction SilentlyContinue)) {
    throw 'The Windows Appx module does not provide Invoke-CommandInDesktopPackage, required for this Store launch.'
  }
  $node = Get-Command $(if ($NodePath) { $NodePath } else { 'node' }) -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js 22 or newer is required for Scene initialization.' }
  $sceneInitializer = Join-Path $PSScriptRoot 'prepare-codex-scene.mjs'
  if (-not (Test-Path -LiteralPath $sceneInitializer)) { throw 'The bundled Scene initializer was not found.' }

  if ($ValidateOnly) {
    Write-Output "Codex config home: $env:CODEX_HOME"
    Write-Output "Codex executable: $executable"
    Write-Output "Codex processes: $($running.Count)"
    Write-Output "Codex requested debug port: $Port (0 means automatic)"
    Write-Output "Codex startup timeout: $StartupTimeoutSeconds seconds"
    Write-Output "Scene initializer: $sceneInitializer"
    Write-Output "Skin data directory: $env:CODEX_SKIN_DATA_DIR"
    Write-Output "Node executable: $($node.Source)"
    Write-Output 'Launcher validation passed.'
    exit 0
  }

  Write-LauncherLog "Starting launcher; port=$Port; executable=$executable; package=$($script:codexStorePackage.PackageFamilyName); running=$($running.Count)"
  if ($Port -ne 0 -and -not (Find-CodexDebugEndpoint -DebugPort $Port)) {
    Assert-DebugPortAvailable -DebugPort $Port
  }

  if ($running.Count -gt 0) {
    $stage = 'confirm-restart'
    $choice = Show-LauncherMessage `
      -Text "Codex is already running.`n`nRestart it now with your original Codex configuration and Wallpaper Skin support? Running tasks may be interrupted." `
      -Buttons ([System.Windows.MessageBoxButton]::YesNo) `
      -Icon ([System.Windows.MessageBoxImage]::Warning)
    if ($choice -ne [System.Windows.MessageBoxResult]::Yes) {
      Write-LauncherLog 'Restart declined; existing Codex left untouched.'
      exit 0
    }

    $running | ForEach-Object {
      if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $stillRunning = @(Get-CodexProcesses -Executable $executable)
    } while ($stillRunning.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($stillRunning.Count -gt 0) { throw 'Codex did not close within 15 seconds.' }
  }

  $stage = 'prepare-debug-output'
  if ($Port -ne 0) { Assert-DebugPortAvailable -DebugPort $Port }
  Write-DebugEndpointRecord -ActualPort 0
  $debugLog = Join-Path $env:CODEX_SKIN_DATA_DIR "debug-launch-$([Guid]::NewGuid().ToString('N')).stderr.log"
  $stage = 'start-desktop'
  $launched = Start-CodexDesktop -Executable $executable `
    -Arguments "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$Port", "--site-per-process" -DebugLog $debugLog
  $stage = 'wait-debug-endpoint'
  Write-LauncherLog "Waiting for the exact Codex main page; timeoutSeconds=$StartupTimeoutSeconds; processId=$($launched.Id); debugLog=$debugLog"
  $readinessWatch = [Diagnostics.Stopwatch]::StartNew()
  $endpoint = Wait-CodexDebugEndpoint -DebugPort $Port -DebugLog $debugLog -TimeoutSeconds $StartupTimeoutSeconds -ProcessId $launched.Id
  Write-LauncherLog "Codex main page ready; elapsedMs=$($readinessWatch.ElapsedMilliseconds); endpoint=$endpoint"
  $stage = 'initialize-scene'
  $initialization = & $node.Source $sceneInitializer --port ([uri]$endpoint).Port
  if ($LASTEXITCODE -ne 0) { throw 'The Codex Scene page could not initialize. See the initializer error above.' }
  Write-LauncherLog "Scene page initialized: $initialization"
  Write-DebugEndpointRecord -ActualPort ([uri]$endpoint).Port -ProcessId $launched.Id
  Write-LauncherLog "Codex wallpaper debug endpoint ready: $endpoint"
} catch {
  if ($ValidateOnly) {
    Write-Error $_.Exception.Message -ErrorAction Continue
  } else {
    $diagnostic = "Stage: $stage`nExecutable: $executable`nPackage: $($script:codexStorePackage.PackageFamilyName)`n$($_.Exception.Message)"
    Write-LauncherLog "FAILED: $diagnostic"
    Show-LauncherMessage -Text "Could not start Codex Wallpaper Skin.`n`n$diagnostic`n`nLog: $(Join-Path $env:CODEX_SKIN_DATA_DIR 'launcher.log')" -Icon ([System.Windows.MessageBoxImage]::Error) | Out-Null
  }
  exit 1
}
