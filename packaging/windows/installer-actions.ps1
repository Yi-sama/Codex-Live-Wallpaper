param(
  [ValidateSet('Check', 'Install', 'Uninstall')]
  [string]$Action = 'Install',
  [string]$AppRoot = $PSScriptRoot,
  [string]$DataDir,
  [string]$CodexHome,
  [string]$CodexCliPath,
  [string]$DesktopShortcut,
  [string]$StartMenuShortcut,
  [string]$LogFile
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-plugin-wallpaper-engine-codex'
$marketplaceName = 'codex-live-wallpaper'
$selector = "$pluginName@$marketplaceName"
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$recordPath = Join-Path $AppRoot 'installation.json'

function Write-JsonFile {
  param([string]$Path, $Value)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20) + "`n", [Text.UTF8Encoding]::new($false))
}

function Find-CodexCli {
  $override = if ($CodexCliPath) { $CodexCliPath } else { $env:CODEX_CLI_PATH }
  if ($override) {
    if (-not (Test-Path -LiteralPath $override -PathType Leaf)) { throw 'The selected Codex CLI does not exist.' }
    return Resolve-CodexCli -Path $override
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\bin\codex.exe')
  )
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
  if ($package) {
    $candidates += Join-Path $package.InstallLocation 'app\resources\codex.exe'
    $candidates += Join-Path $package.InstallLocation 'app\resources\bin\codex.exe'
  }
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\codex.exe'
  if ($command -and $command.Source -ne $alias) { $candidates += $command.Source }
  $found = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $found) { throw 'The Codex desktop bundled CLI was not found. A WindowsApps execution alias is not the bundled CLI. Install or repair the official Codex desktop app, then run setup again.' }
  return Resolve-CodexCli -Path $found
}

function Resolve-CodexCli {
  param([string]$Path)
  $Path = [IO.Path]::GetFullPath($Path)
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\codex.exe'
  if ($Path -eq $alias) { throw 'A WindowsApps execution alias is not the bundled Codex CLI.' }
  if ($Path -notmatch '\\Program Files\\WindowsApps\\') { return $Path }

  # Match the desktop app's content-addressed relocation, including its helper executables.
  $sourceRoot = Split-Path -Parent $Path
  $files = foreach ($name in @('codex.exe', 'codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe')) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The Store Codex CLI bundle is incomplete: $source" }
    [pscustomobject]@{ Name = $name; Source = $source; Hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash }
  }
  $key = ($files | ForEach-Object { $_.Name + [char]0 + $_.Hash.ToLowerInvariant() + [char]0 }) -join ''
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
  } finally { $sha.Dispose() }
  $cache = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\$hash"
  if (Test-CodexCliBundle -Root $cache -Files $files) { return Join-Path $cache 'codex.exe' }

  # Executable handles can outlive the CLI call. Retain verified bundles, never replace in-use files.
  $runtime = Join-Path $env:LOCALAPPDATA 'CodexLiveWallpaper\runtime\codex-cli'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  foreach ($directory in (Get-ChildItem -LiteralPath $runtime -Directory -Filter "$hash-*")) {
    if (Test-CodexCliBundle -Root $directory.FullName -Files $files) {
      return Join-Path $directory.FullName 'codex.exe'
    }
  }
  $bundle = Join-Path $runtime ("$hash-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $bundle | Out-Null
  foreach ($file in $files) {
    [IO.File]::WriteAllBytes((Join-Path $bundle $file.Name), [IO.File]::ReadAllBytes($file.Source))
  }
  if (-not (Test-CodexCliBundle -Root $bundle -Files $files)) { throw "The copied Codex CLI bundle failed verification: $bundle" }
  return Join-Path $bundle 'codex.exe'
}

function Test-CodexCliBundle {
  param([string]$Root, $Files)
  foreach ($file in $Files) {
    $destination = Join-Path $Root $file.Name
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $file.Hash) {
      return $false
    }
  }
  return $true
}

function Invoke-Codex {
  param([string[]]$Arguments)
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $script:cli
  # Windows PowerShell 5.1 requires quoting for the native Windows argument parser.
  $quoted = foreach ($argument in $Arguments) {
    $escaped = [regex]::Replace($argument, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    '"' + $escaped + '"'
  }
  $info.Arguments = $quoted -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  try {
    try {
      if (-not $process.Start()) { throw 'Process creation returned false.' }
    } catch {
      throw "Cannot start Codex CLI at '$script:cli'. $($_.Exception.Message)"
    }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $output = $stdout.GetAwaiter().GetResult()
    $diagnostic = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw "Codex CLI '$script:cli' exited with code $($process.ExitCode): $($Arguments -join ' ')`n$output`n$diagnostic"
    }
    if ($diagnostic -and $LogFile) {
      [IO.File]::AppendAllText($LogFile, "CLI: $script:cli`n$diagnostic`n", [Text.UTF8Encoding]::new($false))
    }
    return $output
  } finally {
    $process.Dispose()
  }
}

function Set-CodexShortcutIcons {
  param([string[]]$Paths, [string]$PluginRoot)
  $existing = @($Paths | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
  if (-not $existing.Count) { return }
  . (Join-Path $PluginRoot 'scripts\codex-desktop.ps1')
  $executable = Find-CodexExecutable
  if (-not $executable) { throw 'The Codex desktop executable was not found for shortcut icons.' }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($path in $existing) {
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.IconLocation = "$executable,0"
    $shortcut.Save()
  }
}

try {
  $record = if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (-not $CodexHome) {
    $CodexHome = if ($record.codexHome) { $record.codexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  }
  $env:CODEX_HOME = [IO.Path]::GetFullPath($CodexHome)
  $script:cli = Find-CodexCli
  $null = Invoke-Codex -Arguments @('plugin', 'marketplace', 'add', '--help')
  if ($Action -ne 'Uninstall') {
    $listed = Invoke-Codex -Arguments @('plugin', 'list', '--json') | ConvertFrom-Json
    $other = @($listed.installed | Where-Object { $_.name -eq $pluginName -and $_.marketplaceName -ne $marketplaceName })
    if ($other.Count) {
      throw "A wallpaper plugin is already installed from another marketplace ($($other.marketplaceName -join ', ')). Keep its settings and remove that plugin through Codex before installing this edition."
    }
  }
  if ($Action -eq 'Check') {
    Write-Output "Codex plugin support found: $script:cli"
    exit 0
  }

  if ($Action -eq 'Uninstall') {
    if ($record -and $record.registered) {
      $listed = Invoke-Codex -Arguments @('plugin', 'list', '--json') | ConvertFrom-Json
      if (@($listed.installed | Where-Object { $_.pluginId -eq $selector }).Count) {
        $null = Invoke-Codex -Arguments @('plugin', 'remove', $selector)
      }
      $null = Invoke-Codex -Arguments @('plugin', 'marketplace', 'remove', $marketplaceName)
    }
    Write-Output 'Plugin registration removed. Wallpaper data and Codex account files were retained.'
    exit 0
  }

  if (-not $DataDir) {
    $DataDir = if ($record.dataDir) { $record.dataDir } elseif ($env:CODEX_SKIN_DATA_DIR) { $env:CODEX_SKIN_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexLiveWallpaper\data' }
  }
  $DataDir = [IO.Path]::GetFullPath($DataDir)
  $pluginRoot = Join-Path $AppRoot "plugins\$pluginName"
  $nodePath = Join-Path $AppRoot 'runtime\node.exe'
  if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath (Join-Path $pluginRoot '.codex-plugin\plugin.json'))) {
    throw 'The installed plugin or bundled Node runtime is missing. Run the setup again.'
  }
  Set-CodexShortcutIcons -Paths @($DesktopShortcut, $StartMenuShortcut) -PluginRoot $pluginRoot
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Write-JsonFile -Path (Join-Path $pluginRoot '.mcp.json') -Value @{
    mcpServers = @{
      codex_skin = @{
        command = $nodePath
        args = @((Join-Path $pluginRoot 'scripts\mcp-server.mjs'))
        cwd = $pluginRoot
        env = @{ CODEX_SKIN_DATA_DIR = $DataDir; CODEX_SKIN_CDP_PORT = '0' }
      }
    }
  }
  Write-JsonFile -Path (Join-Path $AppRoot '.agents\plugins\marketplace.json') -Value @{
    name = $marketplaceName
    interface = @{ displayName = 'Codex Live Wallpaper' }
    plugins = @(@{
      name = $pluginName
      source = @{ source = 'local'; path = "./plugins/$pluginName" }
      policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
      category = 'Productivity'
    })
  }
  Write-JsonFile -Path $recordPath -Value @{
    dataDir = $DataDir; codexHome = $env:CODEX_HOME; nodePath = $nodePath
    pluginRoot = $pluginRoot; registered = $false
  }
  $null = Invoke-Codex -Arguments @('plugin', 'marketplace', 'add', $AppRoot)
  $null = Invoke-Codex -Arguments @('plugin', 'add', $selector)
  $installed = Invoke-Codex -Arguments @('plugin', 'list', '--json') | ConvertFrom-Json
  if (-not @($installed.installed | Where-Object { $_.pluginId -eq $selector -and $_.enabled }).Count) {
    throw 'Codex did not report the wallpaper plugin as installed and enabled.'
  }
  Write-JsonFile -Path $recordPath -Value @{
    dataDir = $DataDir; codexHome = $env:CODEX_HOME; nodePath = $nodePath
    pluginRoot = $pluginRoot; registered = $true
  }
  Write-Output 'Codex Live Wallpaper registration completed.'
} catch {
  if ($LogFile) {
    [IO.File]::WriteAllText($LogFile, $_.Exception.Message, [Text.UTF8Encoding]::new($false))
  }
  Write-Error $_.Exception.Message -ErrorAction Continue
  exit 1
}
