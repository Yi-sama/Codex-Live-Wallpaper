@echo off
setlocal
set "CODEX_WALLPAPER_DIAGNOSTIC_SELF=%~f0"
set "CODEX_WALLPAPER_DIAGNOSTIC_REPORT=%~dpn0-report.txt"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $text=[IO.File]::ReadAllText($env:CODEX_WALLPAPER_DIAGNOSTIC_SELF); $marker='# BEGIN_DIAGNOSTIC_POWERSHELL'; & ([ScriptBlock]::Create($text.Substring($text.LastIndexOf($marker)+$marker.Length)))" >"%CODEX_WALLPAPER_DIAGNOSTIC_REPORT%" 2>&1
set "result=%errorlevel%"
type "%CODEX_WALLPAPER_DIAGNOSTIC_REPORT%"
echo.
echo Report: "%CODEX_WALLPAPER_DIAGNOSTIC_REPORT%"
if /I not "%~1"=="--no-pause" pause
exit /b %result%
# BEGIN_DIAGNOSTIC_POWERSHELL
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Net.Http
$data = if ($env:CODEX_SKIN_DATA_DIR) { $env:CODEX_SKIN_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexLiveWallpaper\data' }
$log = Get-ChildItem -LiteralPath $data -Filter 'debug-launch-*.stderr.log' -File |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $log) { throw "No native launch log was found in $data." }
$text = [string](Get-Content -LiteralPath $log.FullName -Raw -Encoding UTF8)
$match = [regex]::Match($text, '(?m)^\s*DevTools listening on ws://(?:127\.0\.0\.1|\[::1\]|localhost):(?<port>[0-9]{1,5})/devtools/browser/[^\s]+\s*$')
if (-not $match.Success) { throw "No native loopback debug port was found in $($log.FullName)." }
$port = [int]$match.Groups['port'].Value
if ($port -lt 1 -or $port -gt 65535) { throw 'The native debug port is outside its valid range.' }
$report = [ordered]@{
  diagnosticOnly = $true
  collectedAt = [DateTime]::Now.ToString('s')
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  dataDirectory = $data
  nativeLog = $log.FullName
  port = $port
  processId = $null
  processRunning = $null
  processPath = $null
  requests = @()
}
$startFile = $log.FullName + '.start.json'
if (Test-Path -LiteralPath $startFile) {
  $start = Get-Content -LiteralPath $startFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $report.processId = $start.processId
  $process = Get-Process -Id ([int]$start.processId) -ErrorAction SilentlyContinue
  $report.processRunning = [bool]$process
  if ($process) { $report.processPath = $process.Path }
}
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(3)
try {
  foreach ($address in @('127.0.0.1', '[::1]')) {
    $uri = "http://${address}:$port/json"
    $request = [ordered]@{ uri = $uri; httpStatus = $null; targets = @(); error = $null }
    $response = $null
    try {
      $response = $client.GetAsync($uri).GetAwaiter().GetResult()
      $request.httpStatus = [int]$response.StatusCode
      $response.EnsureSuccessStatusCode() | Out-Null
      $targets = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
      $request.targets = @($targets | ForEach-Object {
        $url = $null
        $path = if ([uri]::TryCreate([string]$_.url, [UriKind]::Absolute, [ref]$url)) {
          $url.GetLeftPart([UriPartial]::Path)
        } else { '(URL unavailable)' }
        [ordered]@{
          type = $_.type
          urlWithoutQueryOrFragment = $path
          hasWebSocket = [bool]$_.webSocketDebuggerUrl
          exactAllowedPage = $_.type -eq 'page' -and $_.url -ceq 'app://-/index.html' -and [bool]$_.webSocketDebuggerUrl
        }
      })
    } catch {
      $request.error = $_.Exception.ToString()
    } finally {
      if ($response) { $response.Dispose() }
    }
    $report.requests += $request
  }
} finally { $client.Dispose() }
$report | ConvertTo-Json -Depth 6
