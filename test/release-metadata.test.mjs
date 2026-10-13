import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('public release metadata is portable and preserves plugin identity and attribution', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  const mcp = JSON.parse(read('.mcp.json')).mcpServers.codex_skin;
  assert.equal(pkg.name, 'codex-live-wallpaper');
  assert.equal(pkg.version, '1.0.0');
  assert.equal(manifest.version, pkg.version);
  assert.ok(read('scripts/mcp-server.mjs').includes(`version: '${pkg.version}'`));
  assert.ok(read('scripts/build-windows-installer.ps1').includes(`[string]$Version = '${pkg.version}'`));
  assert.ok(read('packaging/windows/setup.iss').includes(`#define AppVersion "${pkg.version}"`));
  assert.ok(read('packaging/windows/setup.iss').includes(`#define AppNumericVersion "${pkg.version}"`));
  assert.equal(manifest.name, 'dsh-plugin-wallpaper-engine-codex');
  assert.equal(manifest.interface.displayName, 'Codex Live Wallpaper');
  assert.equal(manifest.repository, 'https://github.com/Yi-sama/Codex-Live-Wallpaper');
  assert.equal(mcp.env.CODEX_SKIN_CDP_PORT, '0');
  assert.equal(mcp.env.CODEX_SKIN_DATA_DIR, undefined);
  assert.ok(!pkg.files.includes('install.ps1'));
  for (const file of pkg.files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
  assert.match(read('LICENSE'), /Copyright \(c\) 2026 JonathandNidhog/);
  assert.match(read('NOTICE.md'), /Mozilla Public License/);
});
