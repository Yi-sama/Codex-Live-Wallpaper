import test from 'node:test';
import assert from 'node:assert/strict';
import { startScenePlayer } from '../src/scene-player.mjs';

function host() {
  const events = new Map();
  const messages = [];
  const requests = [];
  const parent = { postMessage: value => messages.push(value) };
  const window = {
    parent,
    location: { href: 'http://127.0.0.1:1234/scene/token/index.html?paused=1&fit=contain' },
    addEventListener: (name, handler) => events.set(name, handler),
    removeEventListener: (name, handler) => { if (events.get(name) === handler) events.delete(name); },
    fetch: async (url, options) => {
      requests.push({ url: String(url), signal: options?.signal });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({ title: 'Scene' }) };
    },
  };
  return { window, messages, requests, events, command: (data, source = parent) => events.get('message')?.({ data, source }) };
}

test('scene player reports readiness only on the first frame and defers pause until then', async () => {
  const fixture = host();
  const calls = [];
  const controller = { pause: () => calls.push('pause'), resume: () => calls.push('resume'), setFit: value => calls.push(value), setVolume: value => calls.push(value), applyUserProperties: value => calls.push(['props', value]), release: () => calls.push('release') };
  let callbacks;
  let config;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(value, handlers) { config = value; callbacks = handlers; return controller; },
  }));
  assert.equal(config.type, 'scene');
  assert.equal(config.fit, 'contain');
  assert.equal(config.muted, true);
  assert.deepEqual(fixture.messages.filter(message => message.type !== 'codex-scene-diagnostics'), []);
  assert.equal(fixture.messages[0].diagnostics.phase, 'renderer-import');
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.requests, []);
  const abort = new AbortController();
  const bytes = await config.source.scenePkg(abort.signal);
  assert.equal(bytes.byteLength, 8);
  assert.equal(fixture.requests[0].url, 'http://127.0.0.1:1234/scene/token/scene.pkg');
  assert.equal(fixture.requests[0].signal, abort.signal);
  assert.deepEqual(await config.source.project(abort.signal), { title: 'Scene' });
  fixture.command({ type: 'codex-scene-playback', paused: false }, {});
  callbacks.onReady();
  assert.deepEqual(calls, [['props', {}], 'pause', 0]);
  assert.deepEqual(fixture.messages.filter(message => message.type !== 'codex-scene-diagnostics'), [{ type: 'codex-scene-ready' }]);
  fixture.command({ type: 'codex-scene-playback', paused: false, fitMode: 'fill' });
  assert.deepEqual(calls, [['props', {}], 'pause', 0, 'stretch', ['props', {}], 'resume', 0]);
  fixture.events.get('pagehide')();
  assert.equal(calls.at(-1), 'release');
  assert.equal(fixture.events.size, 0);
});

test('Scene audio is silent until ready, keeps its volume while muted and pauses with the scene', async () => {
  const fixture = host();
  fixture.window.location.href += '&muted=0&volume=0.42';
  const calls = [];
  let callbacks;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(config, handlers) {
      assert.equal(config.muted, true, 'Initialization must not play music before readiness.');
      callbacks = handlers;
      return {
        pause: () => calls.push('pause'), resume: () => calls.push('resume'),
        setVolume: value => calls.push(value), applyUserProperties: value => calls.push(['props', value]), release() {},
      };
    },
  }));
  assert.deepEqual(calls, []);
  callbacks.onReady();
  assert.deepEqual(calls.splice(0), [['props', {}], 'pause', 0]);
  fixture.command({ type: 'codex-scene-playback', paused: false });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 0.42]);
  fixture.command({ type: 'codex-scene-playback', paused: false, muted: true });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 0]);
  fixture.command({ type: 'codex-scene-playback', paused: false, muted: false });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 0.42]);
  fixture.command({ type: 'codex-scene-playback', paused: true });
  assert.deepEqual(calls.splice(0), [['props', {}], 'pause', 0]);
  fixture.command({ type: 'codex-scene-playback', paused: false, volume: 2 });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 1]);
  fixture.command({ type: 'codex-scene-playback', paused: false, muted: 'true', volume: '0.1' });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 1], 'Untyped audio settings must be ignored.');
  fixture.command({ type: 'codex-scene-playback', paused: false, volume: -1 });
  assert.deepEqual(calls.splice(0), [['props', {}], 'resume', 0]);
  fixture.command({ type: 'codex-scene-playback', paused: false, volume: 0.8 }, {});
  assert.deepEqual(calls, [], 'Only the actual parent may control Scene audio.');
});

test('scene initialization and render errors are reported and release the renderer', async () => {
  const fixture = host();
  const calls = [];
  let callbacks;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(config, handlers) { callbacks = handlers; return { release: () => calls.push('release') }; },
  }));
  callbacks.onError(new Error('Bad package'));
  callbacks.onReady();
  assert.deepEqual(fixture.messages.filter(message => message.type === 'codex-scene-error'), [{ type: 'codex-scene-error', message: 'Bad package' }]);
  assert.deepEqual(calls, ['release']);
  assert.equal(fixture.events.size, 0);

  const failedImport = host();
  await startScenePlayer(failedImport.window, async () => { throw new Error('Renderer unavailable'); });
  assert.deepEqual(failedImport.messages.filter(message => message.type === 'codex-scene-error'), [{ type: 'codex-scene-error', message: 'Renderer unavailable' }]);

  const renderFailure = host();
  await startScenePlayer(renderFailure.window, async () => ({
    mountCodexScene(config, handlers) { callbacks = handlers; return { release: () => calls.push('release') }; },
  }));
  callbacks.onDiagnostic('render: shader failed', 'error');
  assert.deepEqual(renderFailure.messages.filter(message => message.type === 'codex-scene-error'), [{ type: 'codex-scene-error', message: 'render: shader failed' }]);
});

test('Scene pointer commands require the real parent, readiness and an active player', async () => {
  const fixture = host();
  const calls = [];
  let ready;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(_config, callbacks) {
      ready = callbacks.onReady;
      return { pause() {}, resume() {}, setVolume() {}, release() {},
        pushPointer: (...args) => calls.push(['move', ...args]),
        pushWheel: (...args) => calls.push(['wheel', ...args]),
        pointerLeave: () => calls.push(['leave']),
      };
    },
  }));
  const pointer = { type: 'codex-scene-pointer', action: 'move', u: 0.25, v: 0.75, buttons: 1, mods: 0 };
  fixture.command(pointer);
  ready();
  fixture.command(pointer);
  assert.deepEqual(calls, []);
  fixture.command({ type: 'codex-scene-playback', paused: false, properties: { enabled: { value: false } } });
  fixture.command(pointer, {});
  fixture.command({ ...pointer, u: 2 });
  assert.deepEqual(calls, []);
  fixture.command(pointer);
  fixture.command({ type: 'codex-scene-pointer', action: 'wheel', dx: 0, dy: 10, mode: 0, mods: 0 });
  fixture.command({ type: 'codex-scene-pointer', action: 'leave' });
  assert.deepEqual(calls, [['move', 0.25, 0.75, 1, 0], ['wheel', 0, 10, 0, 0], ['leave']]);
});

test('Scene reports authored projection dimensions and returns rate-limited native canvas snapshots only to its parent', async t => {
  const fixture = host();
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let callbacks;
  let captures = 0;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(_config, handlers) {
      callbacks = handlers;
      return {
        pause() {}, resume() {}, setVolume() {}, release() {},
        snapshot: async () => {
          captures++;
          return { dataUrl: 'data:image/jpeg;base64,AA==', width: 1280, height: 720 };
        },
      };
    },
  }));
  callbacks.onSceneInfo({ width: 3840, height: 2160 });
  callbacks.onReady();
  assert.deepEqual(fixture.messages.filter(message => message.type === 'codex-scene-ready'), [{
    type: 'codex-scene-ready', sourceWidth: 3840, sourceHeight: 2160,
  }]);
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'before-ready' }, {});
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'capture-1' }, {});
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'capture-1' });
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'capture-2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.messages.filter(message => message.type === 'codex-scene-snapshot'), [{
    type: 'codex-scene-snapshot', requestId: 'capture-1', dataUrl: 'data:image/jpeg;base64,AA==',
    width: 1280, height: 720, sourceWidth: 3840, sourceHeight: 2160,
  }]);
  assert.equal(captures, 1);
  now += 2000;
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'capture-2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 1, 'Paused snapshots reuse the retained pre-pause canvas image.');
  assert.deepEqual(fixture.messages.filter(message => message.type === 'codex-scene-snapshot').map(message => message.requestId), ['capture-1', 'capture-2']);
});

test('Scene diagnostics report real render stats, loading phases and pause without calling resume', async t => {
  const fixture = host();
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let report;
  let cleared = false;
  fixture.window.setInterval = callback => { report = callback; return 7; };
  fixture.window.clearInterval = id => { assert.equal(id, 7); cleared = true; };
  fixture.window.location.href = 'http://127.0.0.1:1234/scene/token/index.html?paused=0';
  let callbacks;
  let source;
  let age = 0;
  const calls = [];
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(config, handlers) {
      callbacks = handlers; source = config.source;
      return {
        pause() { calls.push('pause'); }, resume() { calls.push('resume'); }, setVolume() {}, release() {},
        diagnostics: () => ({ fps: 60, lastRenderAgeMs: age, canvasWidth: 640, canvasHeight: 480, webgl2: true }),
      };
    },
  }));
  now += 61000;
  report();
  assert.equal(fixture.messages.at(-1).diagnostics.loadingSlow, true);
  await source.scenePkg();
  assert.equal(fixture.messages.at(-1).diagnostics.packageBytes, 8);
  callbacks.onReady();
  report();
  assert.equal(fixture.messages.at(-1).diagnostics.phase, 'ready');
  assert.equal(fixture.messages.at(-1).diagnostics.fps, 60);
  assert.equal(fixture.messages.at(-1).diagnostics.stalled, false);
  const count = calls.length;
  age = 7000;
  report();
  assert.equal(fixture.messages.at(-1).diagnostics.stalled, true);
  assert.equal(calls.length, count, 'Sampling must not reset render stats by resuming the player.');
  fixture.command({ type: 'codex-scene-playback', paused: true });
  report();
  assert.equal(fixture.messages.at(-1).diagnostics.stalled, false);
  fixture.events.get('webglcontextlost')();
  assert.equal(fixture.messages.at(-1).message, 'WebGL context lost during Scene rendering.');
  assert.equal(cleared, true);
  assert.equal(fixture.events.size, 0);
});

test('failed and empty Scene snapshots reply without replacing or releasing the wallpaper', async t => {
  for (const failure of [null, new Error('Canvas capture failed')]) {
    await t.test(failure ? 'capture rejection' : 'empty capture', async () => {
      const fixture = host();
      fixture.window.location.href = 'http://127.0.0.1:1234/scene/token/index.html?paused=0';
      let ready;
      let releaseCount = 0;
      await startScenePlayer(fixture.window, async () => ({
        mountCodexScene(_config, handlers) {
          ready = handlers.onReady;
          return { pause() {}, resume() {}, setVolume() {}, release() { releaseCount++; },
            snapshot: async () => { if (failure) throw failure; return null; } };
        },
      }));
      ready();
      fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'capture' });
      await new Promise(resolve => setImmediate(resolve));
      const errors = fixture.messages.filter(message => message.type === 'codex-scene-snapshot-error');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].requestId, 'capture');
      assert.equal(errors[0].message, failure?.message || 'The Scene renderer returned no preview image.');
      assert.equal(releaseCount, 0);
      assert.equal(fixture.messages.some(message => message.type === 'codex-scene-error'), false);
      fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'immediate-refresh' });
      assert.equal(fixture.messages.at(-1).type, 'codex-scene-snapshot-error');
      assert.equal(fixture.messages.at(-1).requestId, 'immediate-refresh');
      assert.match(fixture.messages.at(-1).message, /two seconds/);
    });
  }
});

test('a paused Scene capture rejection is handled and still pauses the renderer', async () => {
  const fixture = host();
  let ready;
  let paused = 0;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(_config, handlers) {
      ready = handlers.onReady;
      return { pause() { paused++; }, resume() {}, setVolume() {}, release() {},
        snapshot: async () => { throw new Error('Capture unavailable'); } };
    },
  }));
  ready();
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'paused' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, 1);
  assert.equal(fixture.messages.at(-1).type, 'codex-scene-snapshot-error');
});

test('a successful Scene preview survives pause without requiring more renderer frames', async t => {
  const fixture = host();
  fixture.window.location.href = 'http://127.0.0.1:1234/scene/token/index.html?paused=0';
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let ready;
  let captures = 0;
  let pauses = 0;
  await startScenePlayer(fixture.window, async () => ({
    mountCodexScene(_config, handlers) {
      ready = handlers.onReady;
      return { pause() { pauses++; }, resume() {}, setVolume() {}, release() {},
        snapshot: async () => {
          assert.equal(++captures, 1, 'Paused previews must reuse the successful capture.');
          return { dataUrl: 'data:image/png;base64,AA==', width: 2560, height: 1440 };
        } };
    },
  }));
  ready();
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'visible' });
  await new Promise(resolve => setImmediate(resolve));
  fixture.command({ type: 'codex-scene-playback', paused: true });
  fixture.command({ type: 'codex-scene-snapshot-request', requestId: 'hidden' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 1);
  assert.equal(pauses, 1);
  assert.deepEqual(fixture.messages.filter(message => message.type === 'codex-scene-snapshot')
    .map(message => message.requestId), ['visible', 'hidden']);
});

test('Scene reports slow renderer import and cancels sampling if the page closes before import', async t => {
  const fixture = host();
  fixture.window.location.href = 'http://127.0.0.1:1234/scene/token/index.html';
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let report;
  let cleared = false;
  let finishImport;
  fixture.window.setInterval = callback => { report = callback; return 9; };
  fixture.window.clearInterval = id => { assert.equal(id, 9); cleared = true; };
  const loading = startScenePlayer(fixture.window, () => new Promise(resolve => { finishImport = resolve; }));
  now += 61000;
  report();
  assert.equal(fixture.messages.at(-1).diagnostics.phase, 'renderer-import');
  assert.equal(fixture.messages.at(-1).diagnostics.loadingSlow, true);
  fixture.events.get('pagehide')();
  assert.equal(cleared, true);
  finishImport({ mountCodexScene() { assert.fail('A closed page must not mount a renderer.'); } });
  await loading;
});
