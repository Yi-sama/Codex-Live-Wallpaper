import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSkinService } from '../src/skin-service.mjs';

test('launcher bridge opens first-use picker without MCP and disconnects when Codex exits', async () => {
  const calls = [];
  let running = true;
  const bridge = {
    stateFile: join(mkdtempSync(join(tmpdir(), 'skin-service-')), 'state.json'),
    async showPicker() { assert.equal(this.pinSidebar, true); calls.push('picker'); },
    async disconnect() { calls.push('disconnect'); },
  };
  await runSkinService({ bridge, isRunning: () => running, onReady: () => calls.push('ready'), wait: async () => { running = false; } });
  assert.deepEqual(calls, ['picker', 'ready', 'disconnect']);
});

test('launcher bridge restores saved selection and follows peer selection/removal without reactivating wallpaper', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'skin-service-')), 'state.json');
  const save = id => writeFileSync(stateFile, JSON.stringify({ enabled: true, id }));
  save('one');
  const calls = [];
  let tick = 0;
  const bridge = {
    stateFile, saved: { id: 'one' }, active: { currentId: 'one' },
    async apply(saved, options) {
      assert.equal(this.pinSidebar, true);
      calls.push([saved.id, options.reuseExisting]);
      this.active = { currentId: saved.id };
    },
    async remove() { calls.push('remove'); this.active = this.saved = null; },
    async disconnect() { calls.push('disconnect'); },
  };
  await runSkinService({ bridge, isRunning: () => tick < 3, wait: async () => {
    tick++;
    if (tick === 1) save('two');
    if (tick === 2) unlinkSync(stateFile);
  } });
  assert.deepEqual(calls, [['one', true], ['two', true], 'remove', 'disconnect']);
});

test('launcher bridge cleans up when initialization fails and never operates after app exit', async () => {
  const calls = [];
  const bridge = {
    stateFile: join(mkdtempSync(join(tmpdir(), 'skin-service-')), 'state.json'),
    async showPicker() { throw new Error('Debug target unavailable'); },
    async disconnect() { calls.push('disconnect'); },
  };
  await assert.rejects(runSkinService({ bridge, isRunning: () => true }), /Debug target unavailable/);
  await runSkinService({ bridge, isRunning: () => false });
  assert.deepEqual(calls, ['disconnect', 'disconnect']);
});

test('startup service validates arguments and exits without readiness for another launcher endpoint', () => {
  const script = fileURLToPath(new URL('../scripts/skin-service.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script, '--port', '0', '--process-id', String(process.pid)], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid Codex debug port or process id/);
  const data = mkdtempSync(join(tmpdir(), 'skin-service-endpoint-'));
  writeFileSync(join(data, 'debug-endpoint.json'), JSON.stringify({ port: 1, processId: process.pid + 1 }));
  const retired = spawnSync(process.execPath, [script, '--port', '1', '--process-id', String(process.pid)], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, CODEX_SKIN_DATA_DIR: data },
  });
  assert.ifError(retired.error);
  assert.equal(retired.status, 0);
  assert.equal(retired.stdout, '');
  assert.equal(retired.stderr, '');
});
