param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = '0.3.6',
  [string]$OutputDirectory,
  [string]$WorkDirectory,
  [string]$CompilerPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'outputs\windows' }
if (-not $WorkDirectory) { $WorkDirectory = Join-Path $root 'work\windows-installer' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
$cache = Join-Path $WorkDirectory 'downloads'
$build = Join-Path $WorkDirectory ("build-" + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $build 'payload'
$pluginRoot = Join-Path $payload 'plugins\dsh-plugin-wallpaper-engine-codex'
New-Item -ItemType Directory -Force -Path $cache, $pluginRoot, $OutputDirectory | Out-Null

function Get-VerifiedDownload {
  param([string]$Url, [string]$Name, [string]$Hash)
  $file = Join-Path $cache $Name
  if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Hash) { throw "Download checksum mismatch: $Name" }
  return $file
}

function Write-JsonFile {
  param([string]$Path, $Value)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20) + "`n", [Text.UTF8Encoding]::new($false))
}

if (-not $CompilerPath) {
  $compilerRoot = Join-Path $WorkDirectory 'inno-7.1.0'
  $CompilerPath = Join-Path $compilerRoot 'ISCC.exe'
  if (-not (Test-Path -LiteralPath $CompilerPath)) {
    $setup = Get-VerifiedDownload -Url 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' -Name 'innosetup-7.1.0-x64.exe' -Hash '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
    $compilerProcess = Start-Process -FilePath $setup -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
      '/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS',
      "/DIR=`"$compilerRoot`"", "/LOG=`"$(Join-Path $build 'compiler-bootstrap.log')`""
    )
    if ($compilerProcess.ExitCode -ne 0) { throw "Portable compiler extraction failed: $($compilerProcess.ExitCode)" }
  }
}
if (-not (Test-Path -LiteralPath $CompilerPath)) { throw 'The Inno Setup compiler was not found.' }

$nodeVersion = '24.14.0'
$nodeArchive = Get-VerifiedDownload -Url "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -Name "node-v$nodeVersion-win-x64.zip" -Hash '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66'
$expanded = Join-Path $build 'node'
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $expanded
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -LiteralPath (Join-Path $expanded "node-v$nodeVersion-win-x64\node.exe") -Destination $runtime
Copy-Item -LiteralPath (Join-Path $expanded "node-v$nodeVersion-win-x64\LICENSE") -Destination (Join-Path $runtime 'NODE-LICENSE.txt')

foreach ($name in @('.codex-plugin', 'scripts', 'skills', 'src', 'package.json', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md')) {
  Copy-Item -LiteralPath (Join-Path $root $name) -Destination $pluginRoot -Recurse
}
$publicDocs = Join-Path $pluginRoot 'docs'
New-Item -ItemType Directory -Force -Path $publicDocs | Out-Null
foreach ($name in @('RELEASING.md', 'releases', 'assets')) {
  Copy-Item -LiteralPath (Join-Path $root "docs\$name") -Destination $publicDocs -Recurse
}
foreach ($name in @('installer-actions.ps1', 'start-codex.ps1')) {
  Copy-Item -LiteralPath (Join-Path $root "packaging\windows\$name") -Destination $payload
}
$manifestPath = Join-Path $pluginRoot '.codex-plugin\plugin.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.version = "$Version+windows.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
$manifest.interface.displayName = 'Codex Live Wallpaper'
Write-JsonFile -Path $manifestPath -Value $manifest
Write-JsonFile -Path (Join-Path $pluginRoot '.mcp.json') -Value @{
  mcpServers = @{ codex_skin = @{ command = 'node'; args = @('./scripts/mcp-server.mjs'); cwd = '.'; env = @{ CODEX_SKIN_CDP_PORT = '0' } } }
}

$mplPath = Join-Path $cache 'MPL-2.0.txt'
if (-not (Test-Path -LiteralPath $mplPath)) {
  Invoke-WebRequest -Uri 'https://www.mozilla.org/media/MPL/2.0/index.txt' -OutFile $mplPath -UseBasicParsing
}
Copy-Item -LiteralPath $mplPath -Destination (Join-Path $runtime 'MPL-2.0.txt')
Write-JsonFile -Path (Join-Path $payload 'build-info.json') -Value @{
  version = $Version; pluginVersion = $manifest.version; nodeVersion = $nodeVersion
  architecture = 'x64'; builtAt = [DateTime]::UtcNow.ToString('o')
}

& $CompilerPath "/DPayloadDir=$payload" "/DOutputPath=$OutputDirectory" "/DAppVersion=$Version" (Join-Path $root 'packaging\windows\setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
$exe = Join-Path $OutputDirectory "CodexLiveWallpaper-Setup-$Version-x64.exe"
if (-not (Test-Path -LiteralPath $exe) -or (Get-Item -LiteralPath $exe).Length -lt 1MB) { throw 'The EXE installer was not produced.' }
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$exe.sha256", "$hash  $([IO.Path]::GetFileName($exe))`n", [Text.UTF8Encoding]::new($false))
Write-Output "Installer: $exe"
Write-Output "SHA256: $hash"
Write-Output "Payload: $payload"
