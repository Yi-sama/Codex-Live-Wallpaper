param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'
try {
  $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $record.registered) { throw 'Plugin registration is incomplete. Run the setup again.' }
  $launcher = Join-Path $record.pluginRoot 'scripts\launch-codex-with-skin.ps1'
  & $launcher -DataDir $record.dataDir -NodePath $record.nodePath -CodexHome $record.codexHome -ValidateOnly:$ValidateOnly
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
  if ($ValidateOnly) { Write-Error $_.Exception.Message -ErrorAction Continue } else {
    Add-Type -AssemblyName PresentationFramework
    [Windows.MessageBox]::Show($_.Exception.Message, 'Codex Live Wallpaper') | Out-Null
  }
  exit 1
}
