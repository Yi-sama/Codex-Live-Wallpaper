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
