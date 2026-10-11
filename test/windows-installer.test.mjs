import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

function powershell(command) {
  const env = { ...process.env };
  // Let Windows PowerShell load its own modules instead of inherited PowerShell 7 modules.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${command}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('Windows setup is per-user and ships only an EXE distribution', () => {
  const setup = readFileSync(new URL('../packaging/windows/setup.iss', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../scripts/build-windows-installer.ps1', import.meta.url), 'utf8');
  assert.match(setup, /PrivilegesRequired=lowest/);
  assert.match(setup, /CloseApplications=no/);
  assert.match(setup, /RestartApplications=no/);
  assert.match(setup, /skipifsilent unchecked/);
  assert.doesNotMatch(setup, /filesandordirs|\[Registry\]/);
  assert.doesNotMatch(setup, /Name: "\{localappdata\}.*data/);
  assert.match(build, /Get-FileHash/);
  assert.match(build, /\/PORTABLE=1/);
  assert.match(build, /NODE-LICENSE\.txt/);
  assert.doesNotMatch(build, /Compress-Archive|Remove-Item/);
});

test('Windows packaging scripts parse in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  for (const relative of [
    '../scripts/build-windows-installer.ps1',
    '../packaging/windows/installer-actions.ps1',
    '../packaging/windows/start-codex.ps1',
    '../packaging/windows/verify-installer.ps1',
  ]) {
    const path = fileURLToPath(new URL(relative, import.meta.url)).replaceAll("'", "''");
    powershell(`
      $errors = $null
      $tokens = $null
      $null = [Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw ($errors.Message -join ', ') }
    `);
  }
});

test('single-file launcher diagnostic records both real loopback results without changing app data', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-launch-diagnostic-')));
  const data = join(root, 'data');
  mkdirSync(data);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([
      { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/test' },
      { type: 'page', url: 'https://example.com/login?token=secret#secret', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/other' },
    ]));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const log = join(data, 'debug-launch-test.stderr.log');
  const native = `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/test\n`;
  writeFileSync(log, native);
  writeFileSync(`${log}.start.json`, JSON.stringify({ success: true, processId: process.pid }));
  writeFileSync(join(data, 'state.json'), 'leave wallpaper state unchanged');
  const script = readFileSync(new URL('../scripts/diagnose-launcher.cmd', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /Stop-Process|Start-Process|Invoke-CommandInDesktopPackage|auth\.json|prepare-codex-scene/);
  const diagnostic = join(root, 'diagnose-launcher.cmd');
  writeFileSync(diagnostic, script);
  const command = `& '${diagnostic.replaceAll("'", "''")}' --no-pause; exit $LASTEXITCODE`;
  const env = { ...process.env, CODEX_SKIN_DATA_DIR: data };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { windowsHide: true, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    const report = JSON.parse(readFileSync(join(root, 'diagnose-launcher-report.txt'), 'utf8'));
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.port, port);
    assert.equal(report.processId, process.pid);
    assert.equal(report.processRunning, true);
    assert.equal(report.requests.length, 2);
    assert.equal(report.requests[0].httpStatus, 200);
    assert.equal(report.requests[0].targets[0].exactAllowedPage, true);
    assert.equal(report.requests[0].targets[1].urlWithoutQueryOrFragment, 'https://example.com/login');
    assert.equal(report.requests[0].targets[1].exactAllowedPage, false);
    assert.equal(report.requests[1].httpStatus, null);
    assert.match(report.requests[1].error, /SocketException|TaskCanceledException/);
    assert.doesNotMatch(stdout, /secret/);
    assert.equal(readFileSync(log, 'utf8'), native);
    assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), 'leave wallpaper state unchanged');
  } finally {
    clearTimeout(timer);
  }
});

function installerFunctions() {
  const script = fileURLToPath(new URL('../packaging/windows/installer-actions.ps1', import.meta.url)).replaceAll("'", "''");
  return `
    $ErrorActionPreference = 'Stop'
    $ast = [Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$null)
    $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) |
      ForEach-Object { Invoke-Expression $_.Extent.Text }
    $env:CODEX_CLI_PATH = $null
  `;
}

function launcherFunctions() {
  const script = fileURLToPath(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url)).replaceAll("'", "''");
  return `
    $ErrorActionPreference = 'Stop'
    $ast = [Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$null)
    $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) |
      ForEach-Object { Invoke-Expression $_.Extent.Text }
    $env:CODEX_CLI_PATH = $null
  `;
}

test('Windows launcher finds the manifest GUI and nested bundled CLI without selecting command helpers or aliases', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-launch-discovery-')));
  const store = join(root, 'Program Files', 'WindowsApps', 'OpenAI.Codex');
  const app = join(store, 'app');
  const gui = join(app, 'Codex.exe');
  const cli = join(app, 'resources', 'bin', 'codex.exe');
  mkdirSync(join(app, 'resources', 'bin'), { recursive: true });
  writeFileSync(gui, 'GUI fixture; never executed');
  writeFileSync(cli, 'CLI fixture; never executed');
  writeFileSync(join(store, 'AppxManifest.xml'), `<?xml version="1.0"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Applications>
  <Application Id="CodexCoreCommandRunner" Executable="app/resources/codex-command-runner.exe" />
  <Application Id="App" Executable="app/Codex.exe" />
</Applications></Package>`);
  const quote = value => value.replaceAll("'", "''");
  powershell(`${launcherFunctions()}
    $env:LOCALAPPDATA = '${quote(join(root, 'local'))}'
    $env:ProgramFiles = '${quote(join(root, 'programs'))}'
    function Get-AppxPackage {
      [CmdletBinding()] param([string]$Name)
      return [pscustomobject]@{ InstallLocation = '${quote(store)}'; PackageFamilyName = 'FixturePackage_test' }
    }
    function Get-Command {
      [CmdletBinding()] param([string]$Name)
      return [pscustomobject]@{ Source = (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\codex.exe') }
    }
    $expected = '${quote(gui)}'
    if ((Find-CodexExecutable) -ne $expected) { throw 'The Store manifest GUI was not found.' }
    if ($script:codexStorePackage.PackageFamilyName -ne 'FixturePackage_test') { throw 'The selected GUI lost its Store package identity.' }
    function Get-AppxPackage { [CmdletBinding()] param([string]$Name) return $null }
    $env:CODEX_CLI_PATH = '${quote(cli)}'
    if ((Find-CodexExecutable) -ne $expected) { throw 'A resources/bin CLI did not lead to the GUI.' }
    if ($script:codexStorePackage) { throw 'A nonregistered GUI retained stale package identity.' }
    $env:CODEX_CLI_PATH = $null
    if (Find-CodexExecutable) { throw 'A WindowsApps alias must not be used as the GUI.' }
    function Get-Process {
      [pscustomobject]@{ Id = 1; ProcessName = 'Codex'; Path = $expected }
      [pscustomobject]@{ Id = 2; ProcessName = 'Codex'; Path = 'C:\\unrelated\\Codex.exe' }
      [pscustomobject]@{ Id = 3; ProcessName = 'codex'; Path = '${quote(cli)}' }
    }
    $matched = @(Get-CodexProcesses -Executable $expected)
    if ($matched.Count -ne 1 -or $matched[0].Id -ne 1) { throw 'Process matching must use the selected GUI path and name.' }
  `);
});

test('Windows launcher validation reports missing GUI paths without showing a dialog or writing data', {
  skip: process.platform !== 'win32',
}, () => {
  powershell(`${launcherFunctions()}
    $ValidateOnly = $true
    function Find-CodexExecutable {
      $script:checkedCodexExecutables = @('C:\\fixture\\ChatGPT.exe', 'C:\\fixture\\Codex.exe')
      return $null
    }
    function Show-LauncherMessage { throw 'Validation displayed a dialog.' }
    function Write-LauncherLog { throw 'Validation wrote application data.' }
    $main = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
    $scriptText = $main.Extent.Text.Replace('exit 1', "throw 'fixture validation failed'")
    $failed = $false
    try { & ([scriptblock]::Create($scriptText)) } catch { $failed = $_.Exception.Message -eq 'fixture validation failed' }
    if (-not $failed -or -not @($Error | Where-Object { $_.Exception.Message -like '*not found. Checked:*Codex.exe*' }).Count) {
      throw 'The failure did not report its checked GUI paths.'
    }
    if (@($Error | Where-Object { $_.Exception.Message -like '*Validation displayed*' -or $_.Exception.Message -like '*Validation wrote*' }).Count) {
      throw 'Missing-GUI validation was not read-only.'
    }
  `);
});

test('Windows Store GUI launch uses a package context and preserves profile, arguments, PID and native failures', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-store-gui-')));
  const quote = value => value.replaceAll("'", "''");
  powershell(`${launcherFunctions()}
    $env:CODEX_HOME = '${quote(join(root, 'isolated profile'))}'
    $env:CODEX_SKIN_DATA_DIR = '${quote(join(root, 'data'))}'
    $script:codexStorePackage = [pscustomobject]@{ PackageFamilyName = 'FixturePackage_test' }
    $script:inPackage = $false
    function Start-Process {
      [CmdletBinding()]
      param([string]$FilePath, [string[]]$ArgumentList, [string]$RedirectStandardError, [switch]$PassThru)
      if (-not $script:inPackage) { throw 'A Store GUI was launched without package identity.' }
      if ($script:failLaunch) { throw [ComponentModel.Win32Exception]::new(5, 'fixture access denied') }
      if ($env:CODEX_HOME -ne '${quote(join(root, 'isolated profile'))}' -or $env:CODEX_SKIN_DATA_DIR -ne '${quote(join(root, 'data'))}') {
        throw 'Package helper lost the explicit profile/data environment.'
      }
      if ($ArgumentList -notcontains '--remote-debugging-port=0' -or $ArgumentList -notcontains '--site-per-process' -or -not $PassThru) {
        throw 'Package launch arguments were lost.'
      }
      [IO.File]::WriteAllText($RedirectStandardError, 'DevTools listening on ws://127.0.0.1:49321/devtools/browser/fixture')
      return [pscustomobject]@{ Id = 12345 }
    }
    function Invoke-CommandInDesktopPackage {
      [CmdletBinding()]
      param([string]$PackageFamilyName,[string]$AppId,[string]$Command,[string]$Args,[switch]$PreventBreakaway)
      if ($PackageFamilyName -ne 'FixturePackage_test' -or $AppId -ne 'App' -or -not $PreventBreakaway -or $Args -notlike '*-WindowStyle Hidden*') {
        throw 'The package helper invocation is incorrect.'
      }
      $encoded = ($Args -split ' ')[-1]
      $child = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
      $script:inPackage = $true
      try { & ([scriptblock]::Create($child.Replace('exit 1','return'))) } finally { $script:inPackage = $false }
    }
    $executable = '${quote(join(root, 'Program Files', 'WindowsApps', 'Fixture', 'app', 'ChatGPT.exe'))}'
    $log = '${quote(join(root, 'debug.stderr.log'))}'
    $arguments = @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--site-per-process')
    $process = Start-CodexDesktop -Executable $executable -Arguments $arguments -DebugLog $log
    if ($process.Id -ne 12345 -or (Read-LaunchedDebugPort -DebugLog $log) -ne 49321) { throw 'The PID/debug output was not returned.' }
    $report = Get-Content -LiteralPath ($log + '.start.json') -Raw | ConvertFrom-Json
    if (-not $report.success -or $report.processId -ne 12345) { throw 'The native launch result was not recorded.' }
    $script:failLaunch = $true
    $failed = $false
    try { Start-CodexDesktop -Executable $executable -Arguments $arguments -DebugLog ($log + '.failed') }
    catch { $failed = $_.Exception.Message.Contains('fixture access denied') -and $_.Exception.Message.Contains($executable) -and $_.Exception.Message.Contains('HRESULT') }
    if (-not $failed) { throw 'Actual native failure was suppressed.' }
    $script:codexStorePackage = $null
    $rejected = $false
    try { Start-CodexDesktop -Executable $executable -Arguments $arguments -DebugLog ($log + '.unregistered') }
    catch { $rejected = $_.Exception.Message.Contains('unregistered Store executable') }
    if (-not $rejected) { throw 'An unregistered protected executable was launched directly.' }
  `);
});

test('Windows setup honors an explicit executable override before desktop candidates', {
  skip: process.platform !== 'win32',
}, () => {
  powershell(`${installerFunctions()}
    $env:LOCALAPPDATA = 'C:\\installer-fixture'
    $env:CODEX_CLI_PATH = 'C:\\runtime-fixture\\codex.exe'
    function Test-Path {
      [CmdletBinding()] param([string]$LiteralPath, [string]$PathType)
      return $true
    }
    if ((Find-CodexCli) -ne $env:CODEX_CLI_PATH) { throw 'The runtime override was ignored.' }
    $CodexCliPath = 'C:\\parameter-fixture\\codex.exe'
    if ((Find-CodexCli) -ne $CodexCliPath) { throw 'The explicit parameter was ignored.' }
    $CodexCliPath = $null
    function Test-Path {
      [CmdletBinding()] param([string]$LiteralPath, [string]$PathType)
      return $false
    }
    $rejected = $false
    try { Find-CodexCli } catch { $rejected = $_.Exception.Message.Contains('does not exist') }
    if (-not $rejected) { throw 'A missing override must not silently select a different CLI.' }
  `);
});

test('Windows setup resolves a protected Store bundle without using aliases or stale caches', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-store-')));
  const store = join(root, 'Program Files', 'WindowsApps', 'OpenAI.Codex', 'app', 'resources');
  const local = join(root, 'local');
  const names = ['codex.exe', 'codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe'];
  const combined = createHash('sha256');
  mkdirSync(store, { recursive: true });
  for (const name of names) {
    const bytes = Buffer.from(`fixture bundle ${name}`);
    writeFileSync(join(store, name), bytes);
    combined.update(name).update('\0').update(createHash('sha256').update(bytes).digest('hex')).update('\0');
  }
  const cache = join(local, 'OpenAI', 'Codex', 'bin', combined.digest('hex').slice(0, 16));
  mkdirSync(cache, { recursive: true });
  for (const name of names) writeFileSync(join(cache, name), readFileSync(join(store, name)));
  const stale = join(local, 'OpenAI', 'Codex', 'bin', '0000000000000000');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'codex.exe'), 'stale executable');
  const quote = value => value.replaceAll("'", "''");
  powershell(`${installerFunctions()}
    $env:LOCALAPPDATA = '${quote(local)}'
    $expected = '${quote(join(cache, 'codex.exe'))}'
    function Get-Command {
      [CmdletBinding()] param([string]$Name)
      if ($Name -eq 'codex.exe') {
        return [pscustomobject]@{ Source = (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\codex.exe') }
      }
      Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
    }
    function Get-AppxPackage {
      [CmdletBinding()] param([string]$Name)
      return [pscustomobject]@{ InstallLocation = '${quote(join(root, 'Program Files', 'WindowsApps', 'OpenAI.Codex'))}' }
    }
    $actual = Find-CodexCli
    if ($actual -ne $expected) { throw "Selected protected or stale CLI: $actual" }
    $runtime = Join-Path $env:LOCALAPPDATA 'CodexLiveWallpaper\\runtime\\codex-cli'
    if (Test-Path -LiteralPath $runtime) { throw 'An already verified app cache must not create a private copy.' }
    $env:CODEX_CLI_PATH = '${quote(join(store, 'codex.exe'))}'
    if ((Find-CodexCli) -ne $expected) { throw 'A Store-path environment override must also be relocated.' }
    [IO.File]::WriteAllText('${quote(join(cache, 'codex-command-runner.exe'))}', 'corrupt sibling')
    $actual = Find-CodexCli
    if ($actual -eq $expected -or -not $actual.StartsWith($runtime + '\\')) {
      throw 'A corrupt cache must use a fresh private bundle, never the protected source.'
    }
    foreach ($name in @('codex.exe', 'codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe')) {
      $source = Get-FileHash -LiteralPath (Join-Path '${quote(store)}' $name)
      $copied = Get-FileHash -LiteralPath (Join-Path (Split-Path $actual -Parent) $name)
      if ($source.Hash -ne $copied.Hash) { throw "Private bundle mismatch: $name" }
    }
    if ((Find-CodexCli) -ne $actual) { throw 'A verified private runtime must be reused.' }
    $handle = [IO.File]::Open($actual, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $sibling = Join-Path (Split-Path $actual -Parent) 'codex-command-runner.exe'
      [IO.File]::WriteAllText($sibling, 'corrupt private sibling')
      $replacement = Find-CodexCli
      if ($replacement -eq $actual) { throw 'An invalid occupied private bundle must not be reused.' }
      if ([IO.File]::ReadAllText($sibling) -ne 'corrupt private sibling') { throw 'Setup overwrote an occupied bundle.' }
      [IO.File]::WriteAllText('${quote(join(store, 'codex-command-runner.exe'))}', 'updated source helper')
      $updated = Find-CodexCli
      if ($updated -eq $replacement -or (Split-Path $updated -Leaf) -ne 'codex.exe') { throw 'A new source version must use a new bundle.' }
      $copied = Join-Path (Split-Path $updated -Parent) 'codex-command-runner.exe'
      if ([IO.File]::ReadAllText($copied) -ne 'updated source helper') { throw 'The updated source bundle was not copied.' }
    } finally { $handle.Dispose() }
    if ([IO.File]::ReadAllText('${quote(join(cache, 'codex-command-runner.exe'))}') -ne 'corrupt sibling') {
      throw 'Setup must not modify the official app cache.'
    }
    $env:CODEX_CLI_PATH = $null
    function Get-AppxPackage { [CmdletBinding()] param([string]$Name) return $null }
    $rejected = $false
    try { Find-CodexCli } catch { $rejected = $_.Exception.Message.Contains('execution alias') }
    if (-not $rejected) { throw 'An execution alias alone must not satisfy CLI discovery.' }
  `);
});

test('Windows setup can run and reuse its private Store CLI, while real prerequisite failures remain errors', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-store-start-')));
  const store = join(root, 'Program Files', 'WindowsApps', 'OpenAI.Codex', 'app', 'resources');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'codex.exe'), readFileSync(process.execPath));
  for (const name of ['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) {
    writeFileSync(join(store, name), name);
  }
  const quote = value => value.replaceAll("'", "''");
  powershell(`${installerFunctions()}
    $env:LOCALAPPDATA = '${quote(join(root, 'local'))}'
    $CodexCliPath = '${quote(join(store, 'codex.exe'))}'
    $script:cli = Find-CodexCli
    $private = $script:cli
    if ($private -eq $CodexCliPath) { throw 'The private Store CLI was not prepared.' }
    $result = Invoke-Codex -Arguments @('-e', 'process.stdout.write(JSON.stringify({started:true}));')
    if (-not ($result | ConvertFrom-Json).started) { throw 'The private executable did not actually run.' }
    if ((Find-CodexCli) -ne $private) { throw 'The verified executable was not reused.' }
    if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI')) { throw 'Setup changed the official app runtime.' }
    $env:TEMP = '${quote(join(root, 'private temp'))}'
    $null = New-Item -ItemType Directory -Path $env:TEMP
    $script:cli = Join-Path $PSHOME 'powershell.exe'
    $log = '${quote(join(root, 'failure.txt'))}'
    $rejected = $false
    try {
      Invoke-Codex -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', '${quote(fileURLToPath(new URL('../packaging/windows/installer-actions.ps1', import.meta.url)))}',
        '-Action', 'Check', '-AppRoot', '${quote(join(root, 'unused app'))}',
        '-CodexHome', '${quote(join(root, 'isolated profile'))}', '-CodexCliPath', $CodexCliPath, '-LogFile', $log)
    } catch { $rejected = $_.Exception.Message.Contains('exited with code 1') }
    if (-not $rejected) { throw 'A CLI without plugin commands must still fail the real prerequisite check.' }
    if ((Get-ChildItem -LiteralPath $env:TEMP).Count) { throw 'The action created an unnecessary temporary CLI bundle.' }
    if (-not [IO.File]::ReadAllText($log).Contains($private)) { throw 'The failure diagnostic did not identify the private executable.' }
    if (-not (Test-Path -LiteralPath $private)) { throw 'A failed prerequisite removed the reusable runtime.' }
  `);
});

test('Windows setup keeps native diagnostics out of plugin JSON and preserves quoted arguments', {
  skip: process.platform !== 'win32',
}, () => {
  const script = fileURLToPath(new URL('../packaging/windows/installer-actions.ps1', import.meta.url)).replaceAll("'", "''");
  const node = process.execPath.replaceAll("'", "''");
  powershell(`
    $ast = [Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$null)
    $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Codex' }, $false) |
      ForEach-Object { Invoke-Expression $_.Extent.Text }
    $script:cli = '${node}'
    $value = 'C:\\installation with spaces\\'
    $quoted = 'value"quoted"'
    $result = Invoke-Codex -Arguments @('-e', "process.stderr.write('startup diagnostic\\n');process.stdout.write(JSON.stringify({ok:true,values:process.argv.slice(1)}));", '--', $value, $quoted)
    $parsed = $result | ConvertFrom-Json
    if (-not $parsed.ok -or $parsed.values[0] -ne $value -or $parsed.values[1] -ne $quoted) { throw 'Native stdout or arguments were changed.' }
    $rejected = $false
    try { Invoke-Codex -Arguments @('-e', "process.stderr.write('fixture failure');process.exit(7);") }
    catch {
      $rejected = $_.Exception.Message.Contains('fixture failure') -and $_.Exception.Message.Contains('7') -and $_.Exception.Message.Contains($script:cli)
    }
    if (-not $rejected) { throw 'A failing CLI must report its actual executable, exit code and diagnostic.' }
  `);
});

test('Windows setup decodes UTF-8 diagnostics instead of displaying mojibake', () => {
  const setup = readFileSync(new URL('../packaging/windows/setup.iss', import.meta.url), 'utf8');
  assert.ok((setup.match(/Utf8Decode\(Detail\)/g) || []).length >= 3);
  assert.doesNotMatch(setup, /String\(Detail\)/);
});

test('Windows setup captures process failures and retains diagnostics outside setup temporary storage', () => {
  const setup = readFileSync(new URL('../packaging/windows/setup.iss', import.meta.url), 'utf8');
  assert.match(setup, /ExecAndCaptureOutputWithNativeSysDir/);
  assert.match(setup, /Output\.StdErr/);
  assert.match(setup, /Output\.StdOut/);
  assert.match(setup, /Exit code:/);
  assert.match(setup, /\{localappdata\}\\CodexLiveWallpaper\\logs/);
  assert.match(setup, /UTF8Encode/);
  assert.match(setup, /No action diagnostic was written/);
});

test('Windows registration succeeds while its relocated CLI has a real no-delete file handle', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-cli-locked-')));
  const store = join(root, 'Program Files', 'WindowsApps', 'OpenAI.Codex', 'app', 'resources');
  const app = join(root, 'app');
  mkdirSync(store, { recursive: true });
  mkdirSync(join(app, 'runtime'), { recursive: true });
  mkdirSync(join(app, 'plugins', 'dsh-plugin-wallpaper-engine-codex', '.codex-plugin'), { recursive: true });
  writeFileSync(join(app, 'runtime', 'node.exe'), 'unused runtime fixture');
  writeFileSync(join(app, 'plugins', 'dsh-plugin-wallpaper-engine-codex', '.codex-plugin', 'plugin.json'), '{}');
  for (const name of ['codex.exe', 'codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) {
    writeFileSync(join(store, name), `bundle ${name}`);
  }
  const quote = value => value.replaceAll("'", "''");
  powershell(`${installerFunctions()}
    $env:LOCALAPPDATA = '${quote(join(root, 'local'))}'
    $CodexCliPath = '${quote(join(store, 'codex.exe'))}'
    $selected = Find-CodexCli
    $handle = [IO.File]::Open($selected, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $deleteDenied = $false
      try { [IO.File]::Delete($selected) } catch { $deleteDenied = $true }
      if (-not $deleteDenied) { throw 'The fixture did not hold a real no-delete handle.' }
      function Find-CodexCli { return $selected }
      function Invoke-Codex {
        param([string[]]$Arguments)
        if ($Arguments -contains '--json') {
          return '{"installed":[{"pluginId":"dsh-plugin-wallpaper-engine-codex@codex-live-wallpaper","name":"dsh-plugin-wallpaper-engine-codex","marketplaceName":"codex-live-wallpaper","enabled":true}]}'
        }
      }
      $Action = 'Install'
      $AppRoot = '${quote(app)}'
      $recordPath = Join-Path $AppRoot 'installation.json'
      $DataDir = '${quote(join(root, 'data'))}'
      $CodexHome = '${quote(join(root, 'profile'))}'
      $LogFile = '${quote(join(root, 'action.log'))}'
      $pluginName = 'dsh-plugin-wallpaper-engine-codex'
      $marketplaceName = 'codex-live-wallpaper'
      $selector = "$pluginName@$marketplaceName"
      $main = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
      $scriptText = $main.Extent.Text.Replace('exit 0', 'return').Replace('exit 1', "throw 'fixture action failed'")
      & ([scriptblock]::Create($scriptText))
      $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $record.registered) { throw 'Registration was not recorded as successful.' }
      if (-not (Test-Path -LiteralPath $selected)) { throw 'The in-use CLI was removed.' }
      if (Test-Path -LiteralPath $LogFile) { throw 'Successful registration wrote a failure diagnostic.' }
    } finally { $handle.Dispose() }
  `);
});

test('Windows actions do not delete relocated runtime files after registration', () => {
  const source = readFileSync(new URL('../packaging/windows/installer-actions.ps1', import.meta.url), 'utf8');
  assert.match(source, /CodexLiveWallpaper\\runtime\\codex-cli/);
  assert.match(source, /Test-CodexCliBundle/);
  assert.doesNotMatch(source, /Remove-TemporaryCodexCli|temporaryCliRoot|Remove-Item/);
});

test('installed launcher accepts bundled Node and isolated profile/data paths without launching Codex', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-setup-')));
  const data = join(root, '\u6d4b\u8bd5 data');
  const profile = join(root, 'isolated profile');
  const app = join(root, 'fixture app');
  mkdirSync(join(app, 'resources'), { recursive: true });
  writeFileSync(join(app, 'ChatGPT.exe'), 'GUI fixture; never executed');
  const cli = join(app, 'resources', 'codex.exe');
  writeFileSync(cli, 'CLI fixture; never executed');
  const launcher = fileURLToPath(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url));
  const quote = value => value.replaceAll("'", "''");
  const output = powershell(`
    function Stop-Process { throw 'Validation must not stop Codex.' }
    function Start-Process { throw 'Validation must not launch Codex.' }
    function Get-AppxPackage { [CmdletBinding()] param([string]$Name) return $null }
    $env:CODEX_CLI_PATH = '${quote(cli)}'
    function Get-Command {
      [CmdletBinding()]
      param([string]$Name)
      if ($Name -eq 'node') { throw 'Global Node must not be used.' }
      Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
    }
    & '${quote(launcher)}' -NodePath '${quote(process.execPath)}' -DataDir '${quote(data)}' -CodexHome '${quote(profile)}' -ValidateOnly
  `);
  assert.ok(output.includes(`Codex config home: ${profile}`), output);
  assert.ok(output.includes(`Skin data directory: ${data}`), output);
  assert.ok(output.includes(`Node executable: ${process.execPath}`), output);
  assert.match(output, /Launcher validation passed/);
});
