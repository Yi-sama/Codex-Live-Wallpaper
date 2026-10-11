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
  assert.deepEqual(fixture.messages, []);
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
  assert.deepEqual(fixture.messages, [{ type: 'codex-scene-ready' }]);
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
  assert.deepEqual(fixture.messages, [{ type: 'codex-scene-error', message: 'Bad package' }]);
  assert.deepEqual(calls, ['release']);
  assert.equal(fixture.events.size, 0);

  const failedImport = host();
  await startScenePlayer(failedImport.window, async () => { throw new Error('Renderer unavailable'); });
  assert.deepEqual(failedImport.messages, [{ type: 'codex-scene-error', message: 'Renderer unavailable' }]);

  const renderFailure = host();
  await startScenePlayer(renderFailure.window, async () => ({
    mountCodexScene(config, handlers) { callbacks = handlers; return { release: () => calls.push('release') }; },
  }));
  callbacks.onDiagnostic('render: shader failed', 'error');
  assert.deepEqual(renderFailure.messages, [{ type: 'codex-scene-error', message: 'render: shader failed' }]);
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
