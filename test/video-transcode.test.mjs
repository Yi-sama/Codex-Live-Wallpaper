import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/transcode-video.ps1', import.meta.url));

function powershell(command) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('video transcoder preserves source audio with an AAC MP4 output profile', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /MediaEncodingProfile[^\n]*CreateFromFileAsync\(\$inputFile\)/);
  assert.match(script, /\$sourceHasAudio\s*=\s*\$null\s*-ne\s*\$sourceProfile\.Audio/);
  assert.match(script, /if \(-not \$sourceHasAudio\) \{\s*\$profile\.Audio\s*=\s*\$null\s*\}/s);
  assert.match(script, /elseif \(\$null -eq \$profile\.Audio\) \{\s*throw 'The MP4 output profile did not provide an AAC audio track\.'/s);
  assert.match(script, /CreateFromFileAsync\(\$outputFile\)/);
  assert.match(script, /if \(\$sourceHasAudio -ne \$outputHasAudio\) \{/);
  assert.match(script, /outputHasAudio\s*=\s*\$outputHasAudio/);
  assert.match(script, /hasAudio\s*=\s*\$outputHasAudio/);
  assert.match(script, /audioCodec\s*=\s*if \(\$outputHasAudio\) \{ \[string\]\$outputAudio\.Subtype \}/);
  assert.doesNotMatch(script, /\$profile\.Audio\s*=\s*\$null\s*\r?\n\$profile\.Video/);
});

test('Windows Media MP4 profiles provide the AAC output audio used by the transcoder', {
  skip: process.platform !== 'win32',
}, () => {
  const output = powershell(`
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $profile = [Windows.Media.MediaProperties.MediaEncodingProfile,Windows,ContentType=WindowsRuntime]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality,Windows,ContentType=WindowsRuntime]::HD1080p)
    [pscustomobject]@{
      hasAudio = $null -ne $profile.Audio
      subtype = [string]$profile.Audio.Subtype
      channels = [int]$profile.Audio.ChannelCount
      sampleRate = [int]$profile.Audio.SampleRate
    } | ConvertTo-Json -Compress
  `).trim();
  const profile = JSON.parse(output);
  assert.equal(profile.hasAudio, true);
  assert.equal(profile.subtype, 'AAC');
  assert.ok(profile.channels > 0);
  assert.ok(profile.sampleRate > 0);
});

test('video transcoder parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const escaped = scriptPath.replaceAll("'", "''");
  powershell(`
    $errors = $null
    $tokens = $null
    $null = [Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors.Message -join ', ') }
  `);
});
