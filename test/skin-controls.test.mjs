import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRotation, installSkinFeatures } from '../src/skin-controls.mjs';

test('rotation settings deduplicate and validate sources and clamp timing', () => {
  assert.deepEqual(normalizeRotation({ enabled: true, ids: ['a', 'a', 'missing', 'b'], intervalSeconds: 1, durationMs: 5000 },
    [{ id: 'a' }, { id: 'b' }]), {
    enabled: true, ids: ['a', 'b'], intervalSeconds: 5, transition: 'fade', durationMs: 2000,
  });
  assert.equal(normalizeRotation({ enabled: true, ids: ['a'] }).enabled, false);
  assert.equal(normalizeRotation(null).enabled, false);
});

function fixture(t, { busy = false } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const events = new Map();
  const target = () => ({
    addEventListener(name, handler) { const list = events.get(name) || []; list.push(handler); events.set(name, list); },
    removeEventListener(name, handler) { events.set(name, (events.get(name) || []).filter(value => value !== handler)); },
  });
  let tick;
  const frames = new Map();
  let frameId = 0;
  globalThis.window = { ...target(), setInterval(handler) { tick = handler; return 1; }, clearInterval() { tick = null; } };
  globalThis.document = { ...target(), hidden: false, hasFocus: () => true };
  globalThis.requestAnimationFrame = handler => { frames.set(++frameId, handler); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const cfg = { currentId: 'a', mode: 'scene', mouseEnabled: true,
    rotation: normalizeRotation({ enabled: true, ids: ['a', 'b'], intervalSeconds: 5 }), sourceOptions: [] };
  const selections = [];
  const messages = [];
  const cleanup = installSkinFeatures({ cfg, panel: null, requestSelection: id => selections.push(id), persistSettings() {},
    isBusy: () => busy, getMedia: () => ({
      contentWindow: { postMessage: (data, origin) => messages.push({ data, origin }) },
      getBoundingClientRect: () => ({ left: -50, top: -25, width: 200, height: 100 }),
    }), sceneOrigin: 'http://127.0.0.1:4321' });
  t.after(() => {
    cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { cfg, messages, selections, events, frames, cleanup, tick: () => tick?.(),
    dispatch: (name, data) => (events.get(name) || []).forEach(handler => handler(data)) };
}

test('pointer mapping uses the transformed iframe rect and never consumes host events', t => {
  const host = fixture(t);
  const event = { clientX: 50, clientY: 25, buttons: 1, shiftKey: true,
    target: { closest: () => null }, preventDefault() { assert.fail('Host interaction must not be consumed.'); } };
  host.dispatch('pointermove', event);
  host.dispatch('pointermove', { ...event, clientX: 100 });
  assert.equal(host.frames.size, 1, 'Move events are coalesced per frame.');
  for (const callback of host.frames.values()) callback();
  assert.equal(host.messages[0].data.u, 0.75);
  assert.equal(host.messages[0].data.v, 0.5);
  assert.equal(host.messages[0].origin, 'http://127.0.0.1:4321');
  host.dispatch('pointerdown', { ...event, target: { closest: () => ({}) } });
  assert.equal(host.messages.at(-1).data.action, 'leave');
  const count = host.messages.length;
  host.dispatch('wheel', { ...event, target: { closest: () => ({}) }, deltaX: 0, deltaY: 10, deltaMode: 0 });
  assert.equal(host.messages.length, count);
  host.dispatch('wheel', { ...event, deltaX: 0, deltaY: 20, deltaMode: 0 });
  assert.equal(host.messages.at(-1).data.action, 'wheel');
  assert.equal(host.messages.at(-1).data.dy, 20);
  host.cleanup();
  assert.equal([...host.events.values()].flat().length, 0);
});

test('rotation pauses while hidden or busy and has one timer per runtime', t => {
  const host = fixture(t);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  document.hidden = true;
  now += 100000;
  host.tick();
  assert.deepEqual(host.selections, []);
  document.hidden = false;
  host.dispatch('visibilitychange', {});
  now += 5001;
  host.tick();
  assert.deepEqual(host.selections, ['b']);
  host.cleanup();
  now += 100000;
  host.tick();
  assert.deepEqual(host.selections, ['b']);
});
