import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createServer } from 'node:http';
import { CodexSkinBridge, makeInjectionScript } from '../src/codex-skin.mjs';

function renderer({ ropeLength = null, ropeLeft = null, storageAvailable = true } = {}) {
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
      this.attributes = {};
      this.captureListeners = new Map();
      this.pointerCaptures = new Set();
    }
    addEventListener(type, callback, options) {
      if (options === true || options?.capture) {
        const listeners = this.captureListeners.get(type) || [];
        if (!listeners.includes(callback)) listeners.push(callback);
        this.captureListeners.set(type, listeners);
      } else super.addEventListener(type, callback, options);
    }
    removeEventListener(type, callback, options) {
      if (options === true || options?.capture) {
        this.captureListeners.set(type, (this.captureListeners.get(type) || []).filter(value => value !== callback));
      } else super.removeEventListener(type, callback, options);
    }
    dispatchEvent(event) {
      // The fixture runs capture handlers before target handlers, like a browser.
      for (const listener of this.captureListeners.get(event.type) || []) {
        listener.call(this, event);
        if (event.defaultPrevented) return false;
      }
      return super.dispatchEvent(event);
    }
    setPointerCapture(id) { this.pointerCaptures.add(id); }
    hasPointerCapture(id) { return this.pointerCaptures.has(id); }
    releasePointerCapture(id) { this.pointerCaptures.delete(id); }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { [...this.children].forEach(child => child.remove()); this.append(...children); }
    prepend(child) { this.appendChild(child); this.children.unshift(this.children.pop()); }
    insertBefore(child, next) {
      this.appendChild(child);
      if (next) { this.children.pop(); this.children.splice(this.children.indexOf(next), 0, child); }
    }
    remove() {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    replaceWith(child) {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      child.remove();
      parent.children.splice(index, 1, child);
      child.parentElement = parent;
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    get isConnected() { return this === document.body || this === document.head || !!this.parentElement?.isConnected; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
    querySelectorAll(selector) { return this.all().filter(child => selector.split(',').includes(child.tagName.toLowerCase())); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getContext() { return { drawImage() {} }; }
  }
  class Video extends Element {
    constructor() {
      super('video');
      this.currentTime = 0;
      this.paused = true;
      this.error = null;
      this.src = '';
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class Image extends Element {
    constructor() { super('img'); this.complete = true; this.naturalWidth = 20; this.naturalHeight = 10; }
    decode() { return Promise.resolve(); }
  }
  const document = Object.assign(new EventTarget(), {
    body: new Element('body'),
    head: new Element('head'),
    documentElement: new Element('html'),
    hidden: false,
    hasFocus: () => true,
    createElement: tag => tag === 'video' ? new Video() : new Element(tag),
    getElementById: id => [...document.body.all(), ...document.head.all()].find(element => element.id === id) || null,
  });
  const window = new EventTarget();
  window.innerWidth = 1280;
  window.innerHeight = 816;
  const storage = new Map();
  if (ropeLength !== null) storage.set('codex-wallpaper-rope-length', ropeLength);
  if (ropeLeft !== null) storage.set('codex-wallpaper-rope-left', ropeLeft);
  Object.defineProperty(window, 'localStorage', { get() {
    if (!storageAvailable) throw new Error('Storage denied');
    return { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  } });
  const commands = [];
  window.codexSkinCommand = value => commands.push(JSON.parse(value));
  const revoked = [];
  const timers = new Map();
  let nextTimer = 0;
  window.setInterval = window.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  window.clearInterval = window.clearTimeout = id => timers.delete(id);
  let blobs = 0;
  const context = createContext({
    window, document, HTMLVideoElement: Video, Image, Blob, Uint8Array, Event,
    location: { href: 'app://-/index.html', protocol: 'app:', search: '' },
    URL: class extends URL {
      static revokeObjectURL(value) { revoked.push(value); }
      static createObjectURL() { return `blob:test-${++blobs}`; }
    },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  return {
    window, document, commands, revoked, timers, storage,
    evaluate: source => runInContext(source, context),
    install: settings => runInContext(makeInjectionScript(settings), context),
    video: () => document.getElementById('codex-wallpaper-engine-skin')?.querySelector('video'),
  };
}

const settings = {
  currentId: 'one', mode: 'video-blob', mediaUrl: 'data:image/gif;base64,AA==',
  controllerId: 'first', instanceId: 'first-video',
  panelOpacity: 0.4, sourceOptions: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }],
};

function finishVideo(host, token = 'transfer', instanceId = 'first-video') {
  assert.equal(host.window.__codexWallpaperBeginVideo(token, 3, instanceId), true);
  assert.equal(host.window.__codexWallpaperPushVideoChunk(token, 'YWJj'), true);
  assert.equal(host.window.__codexWallpaperFinishVideo(token, 'video/mp4'), true);
}

test('skin appearance defaults match the sliders and preserve explicit settings', () => {
  for (const overrides of [{}, { panelOpacity: 0.45, scrimOpacity: 0.35, blurPx: 12 }]) {
    const host = renderer();
    const expected = { panelOpacity: 0.2, scrimOpacity: 0.1, blurPx: 3, ...overrides };
    const result = host.install({ mode: 'preview', mediaUrl: 'data:image/png;base64,AA==', ...overrides });
    for (const key of Object.keys(expected)) assert.equal(result.settings[key], expected[key], key);
    assert.equal(host.document.documentElement.style['--codex-skin-panel-opacity'], expected.panelOpacity);
    assert.equal(host.document.documentElement.style['--codex-skin-blur'], `${expected.blurPx}px`);
    const layer = host.document.getElementById('codex-wallpaper-engine-skin');
    assert.ok(layer.children.some(child => child.style.background === `rgba(0,0,0,${expected.scrimOpacity})`));
    const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
    assert.deepEqual(controls.querySelectorAll('input').slice(3, 6).map(input => Number(input.value)),
      [Math.round(expected.panelOpacity * 100), Math.round(expected.scrimOpacity * 100), expected.blurPx]);
  }
});

test('first-use picker does not alter app appearance or save a fake wallpaper and permits first selection', async () => {
  const host = renderer();
  const result = host.install({ mode: 'picker', currentId: null, instanceId: 'picker', sourceOptions: settings.sourceOptions });
  assert.equal(result.mode, 'picker');
  assert.equal(host.document.documentElement.style['--codex-skin-panel-opacity'], undefined);
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin-style'), null);
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin').style.display, 'none');
  assert.equal(host.window.__codexWallpaperPanelTab, 'library');
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), { active: { mode: 'picker' } });
  assert.equal(bridge.savedSettings(), null);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const source = controls.querySelector('select');
  source.value = 'one';
  source.dispatchEvent(new Event('change'));
  assert.equal(host.commands.at(-1).action, 'select-request');
  assert.equal(host.commands.at(-1).id, 'one');
  host.install(settings);
  assert.equal(host.video().tagName, 'VIDEO');
});

test('Scene diagnostic heartbeat is authenticated, visible in status, and does not resume playback', () => {
  const host = renderer();
  const sent = [];
  const child = { postMessage: value => sent.push(value) };
  const originalCreate = host.document.createElement;
  host.document.createElement = tag => {
    const element = originalCreate(tag);
    if (tag === 'iframe') element.contentWindow = child;
    return element;
  };
  host.install({ ...settings, mode: 'scene', scenePageUrl: 'http://127.0.0.1:4321/scene/token/index.html' });
  const dispatch = (source, data) => {
    const event = new Event('message');
    Object.assign(event, { origin: 'http://127.0.0.1:4321', source, data });
    host.window.dispatchEvent(event);
  };
  dispatch(child, { type: 'codex-scene-ready' });
  const count = sent.length;
  const diagnostics = { fps: 45, phase: 'ready', stalled: false, canvasWidth: 640, canvasHeight: 480 };
  dispatch({}, { type: 'codex-scene-diagnostics', diagnostics });
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().sceneDiagnostics, null);
  dispatch(child, { type: 'codex-scene-diagnostics', diagnostics });
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().sceneDiagnostics.fps, 45);
  assert.equal(sent.length, count);
  assert.match(host.document.getElementById('codex-wallpaper-engine-skin-controls').querySelector('pre').textContent, /"fps": 45/);
});

test('empty first-use library hides all adjustments and keyboard navigation stays in the library', () => {
  const host = renderer();
  host.install({ mode: 'picker', currentId: null, sourceOptions: [] });
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const panel = controls.children[1];
  const inputs = panel.querySelectorAll('input').filter(input => input.type === 'range');
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every(input => input.parentElement.style.display === 'none'));
  const nav = panel.children.find(child => child.attributes.role === 'tablist');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    const event = new Event('keydown');
    Object.assign(event, { key });
    nav.children.forEach(child => { child.focus = () => {}; });
    nav.dispatchEvent(event);
    assert.equal(host.window.__codexWallpaperPanelTab, 'library');
  }
  const refresh = controls.querySelectorAll('button').find(child => child.title === '\u5237\u65b0\u58c1\u7eb8');
  refresh.dispatchEvent(new Event('click'));
  assert.equal(host.commands.at(-1).action, 'refresh-sources');
});

test('hanging rope changes only its length, uses local UI storage and follows the saved setting across selection', () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const player = host.video();
  const snapshot = host.window.__codexWallpaperRuntime.snapshot();
  const wheel = (deltaY, deltaMode = 0, ctrlKey = false) => {
    const event = new Event('wheel', { cancelable: true });
    Object.assign(event, { deltaY, deltaMode, ctrlKey });
    handle.dispatchEvent(event);
    return event;
  };
  assert.equal(handle.attributes['aria-label'], '\u76ae\u80a4\u8c03\u6574');
  assert.equal(handle.textContent, '');
  const image = handle.children[1];
  assert.equal(image.tagName, 'IMG');
  assert.match(image.src, /^data:image\/png;base64,/);
  const png = Buffer.from(image.src.split(',')[1], 'base64');
  assert.equal(png.readUInt32BE(16), 288);
  assert.equal(png.readUInt32BE(20), 400);
  assert.equal(png[25], 6, 'Mascot PNG must include its alpha channel.');
  assert.equal(image.draggable, false);
  assert.equal(controls.ropeVersion, 4);
  assert.equal(controls.style['--codex-rope-size'], '84px');
  assert.equal(controls.style['--codex-rope-length'], '56px');
  assert.equal(wheel(100).defaultPrevented, true);
  assert.equal(controls.style['--codex-rope-length'], '88px');
  wheel(-2, 1);
  assert.ok(parseFloat(controls.style['--codex-rope-length']) < 88);
  const before = controls.style['--codex-rope-length'];
  assert.equal(wheel(120, 0, true).defaultPrevented, false);
  assert.equal(controls.style['--codex-rope-length'], before);
  assert.equal(host.video(), player);
  assert.deepEqual(host.window.__codexWallpaperRuntime.snapshot(), snapshot);
  assert.deepEqual(host.commands, [], 'Rope movement must not persist wallpaper adjustments.');
  const saved = host.storage.get('codex-wallpaper-rope-length');
  host.install({ ...settings, currentId: 'two', instanceId: 'two' });
  assert.equal(host.document.getElementById(controls.id).style['--codex-rope-length'], saved + 'px');
  const reloaded = renderer({ ropeLength: saved });
  reloaded.install(settings);
  assert.equal(reloaded.document.getElementById(controls.id).style['--codex-rope-length'], saved + 'px');
  const retired = controls.style['--codex-rope-length'];
  wheel(100);
  assert.equal(controls.style['--codex-rope-length'], retired, 'A retired handle must not retain wheel listeners.');
});

test('rope supports keyboard and Escape, clamps to the viewport and tolerates unavailable UI storage', () => {
  const host = renderer({ ropeLength: 'broken', storageAvailable: false });
  host.install(settings);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const panel = controls.children[1];
  let focused = false;
  handle.focus = () => { focused = true; };
  const key = value => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: value });
    handle.dispatchEvent(event);
    // The minimal DOM fixture has no native parent bubbling.
    Object.defineProperty(event, 'target', { value: handle });
    controls.dispatchEvent(event);
  };
  assert.equal(controls.style['--codex-rope-length'], '56px');
  key('ArrowDown');
  assert.equal(controls.style['--codex-rope-length'], '72px');
  key('End');
  assert.equal(controls.style['--codex-rope-length'], '560px');
  host.window.innerHeight = 220;
  host.window.dispatchEvent(new Event('resize'));
  assert.equal(controls.style['--codex-rope-length'], '91px');
  host.window.innerHeight = 816;
  host.window.dispatchEvent(new Event('resize'));
  assert.equal(controls.style['--codex-rope-length'], '560px', 'Resize does not erase the remembered length.');
  key('Home');
  assert.equal(controls.style['--codex-rope-length'], '16px');
  handle.dispatchEvent(new Event('click'));
  assert.equal(panel.style.display, 'block');
  assert.equal(handle.attributes['aria-expanded'], 'true');
  key('Escape');
  assert.equal(panel.style.display, 'none');
  assert.equal(handle.attributes['aria-expanded'], 'false');
  assert.equal(focused, true);
});

for (const version of [1, 2, 3]) test(`a retained version-${version} rope upgrades to the pullable mascot without restarting media and reuse keeps its handle`, () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const player = host.video();
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  controls.ropeVersion = version;
  const upgraded = host.install({ ...settings, reuseExisting: true });
  assert.equal(upgraded.reused, true);
  assert.equal(host.video(), player);
  assert.equal(controls.ropeVersion, 4);
  const cleanup = host.window.__codexWallpaperRopeCleanup;
  host.install({ ...settings, controllerId: 'peer', reuseExisting: true });
  assert.equal(host.window.__codexWallpaperRopeCleanup, cleanup);
  assert.equal(controls.children[0].children.length, 2);
});

test('mascot dragging captures the pointer, saves both axes and does not turn a drag into a panel click', () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const panel = controls.children[1];
  const player = host.video();
  const snapshot = host.window.__codexWallpaperRuntime.snapshot();
  const pointer = (type, x, y, overrides = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, ...overrides });
    handle.dispatchEvent(event);
    return event;
  };
  const click = () => {
    const event = new Event('click', { cancelable: true });
    Object.assign(event, { detail: 1 });
    handle.dispatchEvent(event);
    return event;
  };
  pointer('pointerdown', 80, 100);
  assert.equal(handle.hasPointerCapture(1), true);
  pointer('pointermove', 82, 102);
  assert.equal(controls.style['--codex-rope-length'], '56px', 'Small click jitter is not a drag.');
  pointer('pointermove', 300, 210, { pointerId: 2 });
  assert.equal(controls.style['--codex-rope-left'], '24px', 'Another pointer cannot take over a drag.');
  pointer('pointermove', 300, 210);
  assert.equal(controls.style['--codex-rope-left'], '244px');
  assert.equal(controls.style['--codex-rope-length'], '166px');
  pointer('pointerup', 300, 210);
  assert.equal(handle.hasPointerCapture(1), false);
  assert.equal(click().defaultPrevented, true);
  assert.equal(panel.style.display, 'none');
  assert.equal(host.video(), player);
  assert.deepEqual(host.window.__codexWallpaperRuntime.snapshot(), snapshot);
  assert.deepEqual(host.commands, []);
  assert.equal(host.storage.get('codex-wallpaper-rope-left'), '244');
  assert.equal(host.storage.get('codex-wallpaper-rope-length'), '166');
  const reloaded = renderer({ ropeLength: '166', ropeLeft: '244' });
  reloaded.install(settings);
  assert.equal(reloaded.document.getElementById(controls.id).style['--codex-rope-left'], '244px');
  host.window.innerWidth = 320;
  host.window.dispatchEvent(new Event('resize'));
  assert.equal(controls.style['--codex-rope-left'], '238px');
  assert.equal(controls.style['--codex-rope-size'], '70px');
  host.window.innerWidth = 1280;
  host.window.dispatchEvent(new Event('resize'));
  assert.equal(controls.style['--codex-rope-left'], '244px', 'Resize retains the wider-window position.');
  pointer('pointerdown', 300, 210);
  pointer('pointerup', 300, 210);
  assert.equal(click().defaultPrevented, false);
  assert.equal(panel.style.display, 'block');
});

test('holding the rope pulls only vertically, pauses idle sway and retains the new length without opening the panel', () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const strand = handle.children[0];
  const player = host.video();
  const snapshot = host.window.__codexWallpaperRuntime.snapshot();
  const pointer = (type, x, y) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'target', { value: strand });
    handle.dispatchEvent(event);
    return event;
  };
  assert.equal(pointer('pointerdown', 56, 24).defaultPrevented, true);
  const [timer, held] = [...host.timers.entries()].at(-1);
  pointer('pointermove', 100, 84);
  assert.equal(controls.style['--codex-rope-length'], '56px', 'Pull waits for the long press.');
  held();
  assert.equal(controls.style['--codex-rope-length'], '116px', 'Held pull uses the current pointer position.');
  assert.equal(controls.style['--codex-rope-left'], '24px', 'Pulling the rope does not move it sideways.');
  assert.equal(handle.attributes['data-rope-dragging'], '');
  pointer('pointermove', 160, 120);
  assert.equal(controls.style['--codex-rope-length'], '152px');
  pointer('pointerup', 160, 120);
  assert.equal(host.timers.has(timer), false);
  assert.equal(handle.attributes['data-rope-dragging'], undefined);
  assert.equal(handle.hasPointerCapture(1), false);
  const click = new Event('click', { cancelable: true });
  Object.assign(click, { detail: 1 });
  assert.equal(handle.dispatchEvent(click), false);
  assert.equal(controls.children[1].style.display, 'none');
  assert.equal(host.storage.get('codex-wallpaper-rope-length'), '152');
  assert.equal(host.video(), player);
  assert.deepEqual(host.window.__codexWallpaperRuntime.snapshot(), snapshot);
  assert.deepEqual(host.commands, []);
});

test('rope taps and cancelled or retired holds leave no delayed pull and keep ordinary mascot clicks working', () => {
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'retire']) {
    const host = renderer();
    host.install(settings);
    const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
    const handle = controls.children[0];
    const down = new Event('pointerdown', { cancelable: true });
    Object.assign(down, { pointerId: 1, button: 0, isPrimary: true, clientX: 56, clientY: 24 });
    Object.defineProperty(down, 'target', { value: handle.children[0] });
    handle.dispatchEvent(down);
    const [timer, held] = [...host.timers.entries()].at(-1);
    if (end === 'retire') {
      host.install({ ...settings, currentId: 'two', instanceId: 'two' });
    } else {
      const up = new Event(end);
      Object.assign(up, { pointerId: 1 });
      handle.dispatchEvent(up);
    }
    assert.equal(host.timers.has(timer), false, end);
    held();
    assert.equal(controls.style['--codex-rope-length'], '56px', end);
    assert.equal(handle.attributes['data-rope-dragging'], undefined, end);
    assert.equal(handle.hasPointerCapture(1), false, end);
    if (end === 'pointerup') {
      const tap = new Event('click', { cancelable: true });
      Object.assign(tap, { detail: 1 });
      assert.equal(handle.dispatchEvent(tap), false);
      assert.equal(controls.children[1].style.display, 'none');
      handle.dispatchEvent(new Event('click'));
      assert.equal(controls.children[1].style.display, 'block');
    }
  }
});

test('drag bounds and cancellation leave normal clicks and wheel input working', () => {
  const host = renderer({ storageAvailable: false });
  host.install(settings);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const pointer = (type, x, y, overrides = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, ...overrides });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 80, 100, { button: 2 });
  assert.equal(handle.hasPointerCapture(1), false);
  pointer('pointerdown', 80, 100);
  pointer('pointermove', 10000, 10000);
  assert.equal(controls.style['--codex-rope-left'], '1184px');
  assert.equal(controls.style['--codex-rope-length'], '560px');
  pointer('pointermove', -10000, -10000);
  assert.equal(controls.style['--codex-rope-left'], '12px');
  assert.equal(controls.style['--codex-rope-length'], '16px');
  pointer('pointercancel', -10000, -10000);
  assert.equal(handle.hasPointerCapture(1), false);
  assert.equal(handle.attributes['data-rope-dragging'], undefined);
  pointer('pointermove', 300, 300);
  assert.equal(controls.style['--codex-rope-left'], '12px');
  handle.dispatchEvent(new Event('click', { cancelable: true }));
  assert.equal(controls.children[1].style.display, 'block');
  const wheel = new Event('wheel', { cancelable: true });
  Object.assign(wheel, { deltaY: 120, deltaMode: 0 });
  handle.dispatchEvent(wheel);
  assert.equal(controls.style['--codex-rope-length'], '48px');
});

test('explicit skin removal releases rope events and removes the entry without clearing its UI preference', async () => {
  const host = renderer();
  host.install(settings);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const handle = controls.children[0];
  const down = new Event('pointerdown');
  Object.assign(down, { pointerId: 1, button: 0, isPrimary: true, clientX: 60, clientY: 80 });
  handle.dispatchEvent(down);
  assert.equal(handle.hasPointerCapture(1), true);
  const file = join(mkdtempSync(join(tmpdir(), 'skin-rope-remove-')), 'state.json');
  const client = { async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; }, close() {} };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    stateFile: file, clients: new Map([['fixture', client]]), streamGeneration: 0,
    async ensureClients() {}, sceneRuntime: { async close() {} },
  });
  await bridge.remove();
  assert.equal(host.document.getElementById(controls.id), null);
  assert.equal(host.window.__codexWallpaperRopeCleanup, null);
  assert.equal(handle.hasPointerCapture(1), false);
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaY: 100, deltaMode: 0 });
  handle.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(host.window.__codexWallpaperRopeLength, 56);
});

test('skin appearance defaults apply without replacing saved settings on restore', async t => {
  const root = mkdtempSync(join(tmpdir(), 'skin-appearance-'));
  const project = join(root, 'projects', 'myprojects', 'appearance');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, 'wallpaper64.exe'), '');
  writeFileSync(join(project, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.json', preview: 'preview.png' }));
  writeFileSync(join(project, 'preview.png'), 'preview');
  const previousHome = process.env.WALLPAPER_ENGINE_HOME;
  process.env.WALLPAPER_ENGINE_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.WALLPAPER_ENGINE_HOME;
    else process.env.WALLPAPER_ENGINE_HOME = previousHome;
    clearInterval(bridge.watchdog);
  });
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    stateFile: join(root, 'state.json'), streamGeneration: 0,
    sceneRuntime: { async librarySources() { return []; } },
    async injectCurrent() { return [{ installed: true }]; },
    async debugStatus() { return { available: true }; },
  });
  const result = await bridge.apply({ id: 'local:appearance' });
  for (const [key, value] of Object.entries({ panelOpacity: 0.2, scrimOpacity: 0.1, blurPx: 3 })) {
    assert.equal(result.settings[key], value, key);
  }
  const custom = { panelOpacity: 0.45, scrimOpacity: 0.35, blurPx: 12 };
  await bridge.apply({ id: 'local:appearance', ...custom });
  bridge.active = null;
  assert.equal(await bridge.restoreSaved(), true);
  const saved = JSON.parse(readFileSync(bridge.stateFile, 'utf8'));
  for (const key of Object.keys(custom)) {
    assert.equal(bridge.active[key], custom[key], key);
    assert.equal(saved[key], custom[key], key);
  }
});

test('automatic restoration reuses the same player, Blob, progress and controls', () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const video = host.video();
  video.currentTime = 37;
  const blob = host.window.__codexWallpaperBlobUrl;
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const opacity = controls.querySelectorAll('input')[3];
  opacity.value = '35';
  opacity.dispatchEvent(new Event('input'));

  const restored = host.install({ ...settings, controllerId: 'second', instanceId: 'second-video', panelOpacity: 0.82, reuseExisting: true });
  assert.equal(restored.reused, true);
  assert.equal(restored.instanceId, 'first-video');
  assert.equal(restored.settings.panelOpacity, 0.35);
  assert.equal(host.video(), video);
  assert.equal(video.currentTime, 37);
  assert.equal(host.window.__codexWallpaperBlobUrl, blob);
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin-controls'), controls);
  assert.deepEqual(host.revoked, []);

  const source = controls.querySelector('select');
  source.value = 'two';
  source.dispatchEvent(new Event('change'));
  assert.equal(host.commands.at(-1).controllerId, 'second');
  assert.equal(host.commands.at(-1).id, 'two');
  assert.equal(host.commands.at(-1).settings.panelOpacity, 0.35);

  host.window.__codexWallpaperReleaseController('second');
  source.dispatchEvent(new Event('change'));
  assert.equal(host.commands.at(-1).controllerId, 'first');
  assert.equal(host.video(), video);
});

test('restoration refreshes library preview URLs without replacing healthy playback or controls', () => {
  const host = renderer();
  const sources = port => settings.sourceOptions.map(item => ({
    ...item, type: 'video', thumbnailUrl: `http://127.0.0.1:${port}/preview/${item.id}`,
  }));
  host.install({ ...settings, sourceOptions: sources(10001) });
  finishVideo(host);
  const video = host.video();
  video.currentTime = 37;
  const blob = host.window.__codexWallpaperBlobUrl;
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const panel = controls.children[1];
  const search = controls.querySelectorAll('input').find(input => input.type === 'search');
  search.value = 'Two';
  search.dispatchEvent(new Event('input'));
  const before = panel.querySelector('img');
  const grid = before.parentElement.parentElement.parentElement;
  grid.scrollTop = 24;
  const result = host.install({ ...settings, sourceOptions: sources(10002), controllerId: 'second', reuseExisting: true });
  assert.equal(result.reused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(host.window.__codexWallpaperRuntime.config.sourceOptions)), sources(10002));
  assert.equal(panel.querySelectorAll('img').length, 1);
  const refreshed = panel.querySelector('img');
  assert.equal(refreshed.src, sources(10002)[1].thumbnailUrl);
  assert.equal(search.value, 'Two');
  assert.equal(grid.scrollTop, 24);
  assert.equal(host.video(), video);
  assert.equal(video.currentTime, 37);
  assert.equal(host.window.__codexWallpaperBlobUrl, blob);
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin-controls'), controls);
  assert.equal(host.commands.length, 0, 'Thumbnail refresh must not select a wallpaper or persist settings.');
  host.install({ ...settings, sourceOptions: sources(10002), reuseExisting: true });
  assert.equal(panel.querySelector('img'), refreshed, 'Unchanged URLs must not rebuild the library.');
});

test('a pinned sidebar keeps its live library URLs when a short-lived chat bridge restores', () => {
  const host = renderer();
  const liveSources = settings.sourceOptions.map(item => ({ ...item, thumbnailUrl: 'http://127.0.0.1:10001/' + item.id }));
  host.install({ ...settings, sourceOptions: liveSources });
  finishVideo(host);
  const runtime = host.window.__codexWallpaperRuntime;
  host.window.__codexWallpaperSidebarSession = { controllerId: 'first', runtime };
  const result = host.install({ ...settings, controllerId: 'temporary', reuseExisting: true,
    sourceOptions: settings.sourceOptions.map(item => ({ ...item, thumbnailUrl: 'http://127.0.0.1:10002/' + item.id })) });
  assert.equal(result.reused, true);
  assert.equal(runtime.config.controllerId, 'first');
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.config.sourceOptions)), liveSources);
  assert.equal(host.window.__codexWallpaperRuntime, runtime);
});

test('library refresh coalesces requests and updates only the owning renderer without reinjection', async () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  host.window.top = host.window;
  const runtime = host.window.__codexWallpaperRuntime;
  const video = runtime.getMedia();
  video.currentTime = 19;
  let refreshed = 0;
  runtime.sidebar = { refreshLibrary(error) { assert.equal(error, null); refreshed++; } };
  const sources = settings.sourceOptions.map(item => ({ ...item, thumbnailUrl: 'http://127.0.0.1:10003/' + item.id }));
  let complete;
  let scans = 0;
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', active: { ...settings },
    sceneRuntime: { librarySources() { scans++; return new Promise(resolve => { complete = resolve; }); } },
    clients: new Map([['main', { async call(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: host.evaluate(params.expression) } };
    } }]]),
    injectCurrent() { throw new Error('Library refresh must not reinject media.'); },
    persistActive() { throw new Error('Library refresh must not write user settings.'); },
  });
  const first = bridge.refreshSources();
  const second = bridge.refreshSources();
  complete(sources);
  await Promise.all([first, second]);
  assert.equal(scans, 1);
  assert.equal(refreshed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.config.sourceOptions)), sources);
  assert.equal(host.window.__codexWallpaperRuntime, runtime);
  assert.equal(runtime.getMedia(), video);
  assert.equal(video.currentTime, 19);
  runtime.config.controllerId = 'other';
  const ignored = bridge.refreshSources();
  complete([]);
  await ignored;
  assert.equal(refreshed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.config.sourceOptions)), sources);
});

test('a blocked Scene frame reports the real policy error and stops loading', () => {
  const host = renderer();
  const config = { ...settings, mode: 'scene', scenePageUrl: 'http://127.0.0.1:4321/scene/token/index.html' };
  host.install(config);
  const violation = (blockedURI, disposition = 'enforce') => {
    const event = new Event('securitypolicyviolation');
    Object.assign(event, { blockedURI, disposition, effectiveDirective: 'frame-src' });
    host.document.dispatchEvent(event);
  };
  violation('http://127.0.0.1:9999');
  violation('http://127.0.0.1:4321', 'report');
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().sceneLoading, true);
  violation('http://127.0.0.1:4321');
  const status = host.window.__codexWallpaperRuntime.snapshot();
  assert.equal(status.sceneLoading, false);
  assert.match(status.sceneError, /Codex/);
  assert.equal(host.window.__codexWallpaperRuntime.failed, true);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  assert.match(controls.children[1].children[2].textContent, /加载失败/);
  assert.equal(controls.children[1].children[3].children[0].style.background, '#ef5350');
  host.install(settings);
  violation('http://127.0.0.1:4321');
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().sceneError, null);
});

test('Scene playback messaging waits until its remote frame reports readiness', () => {
  const host = renderer();
  const originalCreate = host.document.createElement;
  const commands = [];
  const reads = [];
  let ready = false;
  const child = { postMessage: (...args) => commands.push(args) };
  host.document.createElement = tag => {
    const element = originalCreate(tag);
    if (tag === 'iframe') {
      Object.defineProperty(element, 'contentWindow', {
        get() {
          reads.push(ready);
          return child;
        },
      });
    }
    return element;
  };
  host.install({ ...settings, mode: 'scene', scenePageUrl: 'http://127.0.0.1:4321/scene/test/index.html' });
  assert.equal(commands.length, 0);
  assert.equal(reads.length, 0, 'Do not access the remote frame before readiness.');
  for (const origin of ['', 'http://127.0.0.1:4321']) {
    const notification = new Event('message');
    Object.assign(notification, { source: {}, origin, data: { type: 'mcp-notification' } });
    host.window.dispatchEvent(notification);
  }
  assert.equal(reads.length, 0, 'Unrelated Codex notifications must not touch the remote frame.');
  ready = true;
  const event = new Event('message');
  Object.assign(event, { source: child, origin: 'http://127.0.0.1:4321', data: { type: 'codex-scene-ready' } });
  host.window.dispatchEvent(event);
  assert.equal(host.window.__codexWallpaperRuntime.sceneStatus.state, 'ready');
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0].type, 'codex-scene-playback');
  assert.equal(commands[0][0].muted, true);
  assert.equal(commands[0][0].volume, 0.3);
  assert.equal(commands[0][1], 'http://127.0.0.1:4321');
});

test('status reads actual Scene loading and fallback errors without reinjecting wallpaper', async () => {
  const host = renderer();
  host.install({ ...settings, mode: 'scene', scenePageUrl: 'http://127.0.0.1:4321/scene/token/index.html' });
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    active: { ...settings, mode: 'scene' }, saved: null,
    clients: new Map([['fixture', { async call(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: host.evaluate(params.expression) } };
    } }]]),
    async debugStatus() { return { available: true }; },
  });
  const loading = await bridge.status();
  assert.equal(loading.renderers[0].sceneLoading, true);
  const event = new Event('securitypolicyviolation');
  Object.assign(event, { blockedURI: 'http://127.0.0.1:4321', effectiveDirective: 'frame-src', disposition: 'enforce' });
  host.document.dispatchEvent(event);
  const preview = host.document.getElementById('codex-wallpaper-engine-skin').querySelector('img');
  const failed = await bridge.status();
  assert.equal(failed.active.mode, 'scene', 'Requested mode is not proof that Scene rendered.');
  assert.equal(failed.renderers[0].mode, 'preview');
  assert.equal(failed.renderers[0].sceneLoading, false);
  assert.equal(failed.renderers[0].failed, true);
  assert.match(failed.renderers[0].sceneError, /Codex/);
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin').querySelector('img'), preview);
  assert.deepEqual(host.commands, []);
});

test('mute checkbox changes only audio and survives controller handoff and selection', () => {
  const host = renderer();
  const appearance = { panelOpacity: 0.14, scrimOpacity: 0, blurPx: 0 };
  host.install({ ...settings, ...appearance, muted: true, volume: 0.3 });
  finishVideo(host);
  const video = host.video();
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const sound = controls.querySelectorAll('input').find(input => input.type === 'checkbox');
  const volume = controls.querySelectorAll('input').filter(input => input.type === 'range').at(-1);
  assert.equal(sound.attributes['aria-label'], '壁纸静音');
  assert.equal(sound.checked, true);
  assert.equal(volume.value, 30);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.3);
  sound.checked = false;
  sound.dispatchEvent(new Event('change'));
  assert.equal(video.muted, false);
  assert.equal(host.commands.at(-1).settings.muted, false);
  volume.value = '45';
  volume.dispatchEvent(new Event('input'));
  assert.equal(video.volume, 0.45);
  assert.equal(host.commands.at(-1).settings.volume, 0.45);
  sound.checked = true;
  sound.dispatchEvent(new Event('change'));
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.45);
  for (const [key, value] of Object.entries(appearance)) {
    assert.equal(host.window.__codexWallpaperRuntime.snapshot().settings[key], value);
  }
  const result = host.install({ ...settings, controllerId: 'second', muted: false, volume: 1, reuseExisting: true });
  assert.equal(result.reused, true);
  assert.equal(host.video(), video);
  assert.equal(result.settings.muted, true);
  assert.equal(result.settings.volume, 0.45);
  const source = controls.querySelector('select');
  source.value = 'two';
  source.dispatchEvent(new Event('change'));
  assert.equal(host.commands.at(-1).settings.muted, true);
  assert.equal(host.commands.at(-1).settings.volume, 0.45);
  assert.equal(host.commands.at(-1).controllerId, 'second');
  const restarted = renderer();
  restarted.install({ ...settings, ...result.settings });
  assert.equal(restarted.video().muted, true);
  assert.equal(restarted.video().volume, 0.45);
});

test('partial apply keeps saved appearance and audio values, including edits from another chat', async t => {
  const root = mkdtempSync(join(tmpdir(), 'skin-partial-apply-'));
  const project = join(root, 'projects', 'myprojects', 'partial-apply-test');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, 'wallpaper64.exe'), 'fixture');
  writeFileSync(join(project, 'project.json'), JSON.stringify({ title: 'Partial apply', type: 'video', file: 'video.webm' }));
  writeFileSync(join(project, 'video.webm'), 'abc');
  const previousHome = process.env.WALLPAPER_ENGINE_HOME;
  process.env.WALLPAPER_ENGINE_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.WALLPAPER_ENGINE_HOME;
    else process.env.WALLPAPER_ENGINE_HOME = previousHome;
  });
  for (const stale of [false, true]) {
    const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
      stateFile: join(root, `state-${stale}.json`), controllerId: 'partial-apply',
      saved: null, active: null, streamGeneration: 0, watchdog: true,
      sceneRuntime: { async librarySources() { return []; } },
      async injectCurrent() { return [{ installed: true }]; },
    });
    const initial = await bridge.apply({
      id: 'local:partial-apply-test', panelOpacity: 0.14, scrimOpacity: 0, blurPx: 0,
      muted: false, volume: 0.45, fitMode: 'contain', zoom: 125, positionX: 25, positionY: 75,
    });
    if (stale) Object.assign(bridge.active, { panelOpacity: 0.82, scrimOpacity: 0.22, blurPx: 16, volume: 0.3 });
    const result = await bridge.apply({ id: 'local:partial-apply-test', muted: true, volume: undefined });
    assert.deepEqual(result.settings, { ...initial.settings, muted: true },
      stale ? 'Latest shared saved values must beat stale chat settings.' : 'Omitted fields must not reset.');
    const unmuted = await bridge.apply({ id: 'local:partial-apply-test', muted: false, volume: 0 });
    assert.deepEqual(unmuted.settings, { ...initial.settings, muted: false, volume: 0 });
  }
});

test('audio upgrade replaces an older runtime once, then preserves its player on future restores', () => {
  const host = renderer();
  host.install(settings);
  const oldVideo = host.video();
  delete host.window.__codexWallpaperRuntime.config.volume;
  assert.equal(host.install({ ...settings, reuseExisting: true }).reused, false);
  assert.notEqual(host.video(), oldVideo);
  const upgraded = host.video();
  assert.equal(host.install({ ...settings, reuseExisting: true }).reused, true);
  assert.equal(host.video(), upgraded);
});

test('the active controller saves typed audio settings and carries them across selection', async () => {
  const saved = [];
  const selected = [];
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'current', active: { currentId: 'one', muted: true, volume: 0.3, panelOpacity: 0.1 },
    persistActive() { saved.push(this.savedSettings()); },
    async apply(options) { selected.push(options); },
    selectionTask: Promise.resolve(),
  });
  const command = value => bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
    name: 'codexSkinCommand', payload: JSON.stringify({ controllerId: 'current', ...value }),
  } });
  command({ action: 'settings', currentId: 'one', settings: { muted: false, volume: 0.45 } });
  assert.equal(saved.at(-1).muted, false);
  assert.equal(saved.at(-1).volume, 0.45);
  assert.equal(saved.at(-1).panelOpacity, 0.1);
  command({ action: 'settings', settings: { muted: 'true', volume: '1' } });
  assert.equal(bridge.active.muted, false);
  assert.equal(bridge.active.volume, 0.45);
  command({ action: 'settings', settings: { volume: 2 } });
  assert.equal(bridge.active.volume, 1);
  command({ action: 'settings', settings: { volume: -1 } });
  assert.equal(bridge.active.volume, 0);
  command({ action: 'select', id: 'two' });
  await bridge.selectionTask;
  assert.equal(selected[0].muted, false);
  assert.equal(selected[0].volume, 0);
});

test('reuse keeps an in-flight transfer, but explicit apply and a different wallpaper replace it', () => {
  const host = renderer();
  host.install(settings);
  host.window.__codexWallpaperBeginVideo('pending', 3, 'first-video');
  const transfer = host.window.__codexWallpaperVideoChunks;
  const video = host.video();
  assert.equal(host.install({ ...settings, controllerId: 'second', reuseExisting: true }).reused, true);
  assert.equal(host.window.__codexWallpaperVideoChunks, transfer);
  assert.equal(host.video(), video);
  assert.equal(host.window.__codexWallpaperPushVideoChunk('pending', 'YWJj'), true);
  assert.equal(host.window.__codexWallpaperFinishVideo('pending', 'video/mp4'), true);

  const previousBlob = host.window.__codexWallpaperBlobUrl;
  host.install({ ...settings, instanceId: 'explicit-video', panelOpacity: 0.7 });
  assert.notEqual(host.video(), video);
  assert.deepEqual(host.revoked, [previousBlob]);
  assert.equal(host.window.__codexWallpaperBeginVideo('stale', 3, 'first-video'), false);
  assert.equal(host.window.__codexWallpaperVideoChunks, null);

  const explicit = host.video();
  host.install({ ...settings, currentId: 'two', instanceId: 'different-video', reuseExisting: true });
  assert.notEqual(host.video(), explicit);
  const failed = host.video();
  host.window.__codexWallpaperVideoError('transfer failed');
  assert.equal(host.install({ ...settings, currentId: 'two', reuseExisting: true }).reused, false);
  assert.notEqual(host.video(), failed);
});

test('the final video chunk commits playback without a separate completion request', () => {
  const host = renderer();
  host.install(settings);
  host.document.hidden = true;
  host.document.hasFocus = () => false;
  host.window.__codexWallpaperBeginVideo('atomic', 3, 'first-video', 'video/webm');
  host.window.__codexWallpaperPushVideoChunk('atomic', 'YWJj');
  assert.equal(host.window.__codexWallpaperVideoChunks, null);
  assert.ok(host.window.__codexWallpaperBlobUrl);
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().videoLoading, false);
  assert.equal(host.video().paused, true);
  host.document.hidden = false;
  host.document.hasFocus = () => true;
  host.document.dispatchEvent(new Event('focusin'));
  assert.equal(host.video().paused, false);
  assert.equal(host.window.__codexWallpaperFinishVideo('atomic', 'video/webm'), true);
});

test('a new sender claims the remaining bytes without clearing an incomplete video', async () => {
  const host = renderer();
  host.install(settings);
  host.window.__codexWallpaperBeginVideo('old-sender', 6, settings.instanceId);
  host.window.__codexWallpaperPushVideoChunk('old-sender', 'YWJj');
  const pending = host.window.__codexWallpaperVideoChunks;
  const chunks = pending.chunks;
  assert.equal(host.window.__codexWallpaperBeginVideo('new-sender', 6, settings.instanceId, 'video/mp4', true), true);
  assert.equal(host.window.__codexWallpaperVideoChunks, pending);
  assert.equal(pending.chunks, chunks);
  assert.equal(pending.received, 3);
  assert.equal(host.window.__codexWallpaperPushVideoChunk('old-sender', 'YWJj'), false);
  const client = { async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; } };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {});
  await bridge.reportVideoError(new Error('Old sender disconnected'), [client],
    { instanceId: settings.instanceId, token: 'old-sender' });
  assert.equal(host.window.__codexWallpaperVideoChunks, pending, 'Stale errors cannot discard a claimed buffer.');
  assert.equal(host.window.__codexWallpaperRuntime.failed || false, false);
  assert.equal(host.window.__codexWallpaperPushVideoChunk('new-sender', 'ZGVm'), true);
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().videoLoading, false);
  assert.equal(host.window.__codexWallpaperVideoChunks, null);
});

test('loading and switching labels are not overwritten by a focus pause', () => {
  const host = renderer();
  host.document.hidden = true;
  host.document.hasFocus = () => false;
  host.install(settings);
  const controls = host.document.getElementById('codex-wallpaper-engine-skin-controls');
  const status = controls.children[1].children[2];
  assert.doesNotMatch(status.textContent, /^已暂停/);
  host.window.__codexWallpaperBeginVideo('progress', 6, 'first-video');
  host.window.__codexWallpaperPushVideoChunk('progress', 'YWJj');
  host.window.dispatchEvent(new Event('blur'));
  assert.match(status.textContent, /50%/);
  const source = controls.querySelector('select');
  source.value = 'two';
  source.dispatchEvent(new Event('change'));
  host.window.dispatchEvent(new Event('blur'));
  assert.match(status.textContent, /切换/);
});

test('reuse preserves Scene and frame media but initializes a genuinely new document', async () => {
  for (const mode of ['scene', 'frames']) {
    const host = renderer();
    const config = { ...settings, mode, showControls: false, mediaFrames: ['one', 'two'] };
    host.install(config);
    await Promise.resolve();
    const layer = host.document.getElementById('codex-wallpaper-engine-skin');
    const cache = host.window.__codexWallpaperFrameCache;
    assert.equal(host.install({ ...config, controllerId: 'second', reuseExisting: true }).reused, true);
    assert.equal(host.document.getElementById(layer.id), layer);
    assert.equal(host.window.__codexWallpaperFrameCache, cache);
    layer.remove();
    assert.notEqual(host.install({ ...config, reuseExisting: true }).reused, true);
    assert.notEqual(host.document.getElementById(layer.id), layer);
  }
});

test('separate bridges do not transfer an already loaded video again', async () => {
  const host = renderer();
  const file = join(mkdtempSync(join(tmpdir(), 'skin-reuse-')), 'video.mp4');
  writeFileSync(file, 'abc');
  const tasks = [];
  const transfers = [];
  function bridge(name) {
    const client = {
      async call(method, params) {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: name };
        if (method === 'Runtime.evaluate') return { result: { value: host.evaluate(params.expression) } };
        return {};
      },
    };
    const value = Object.assign(Object.create(CodexSkinBridge.prototype), {
      controllerId: name, active: { ...settings, controllerId: name, instanceId: name, videoPath: file, videoBytes: 3 },
      clients: new Map([[name, client]]), streamGeneration: 1,
      async ensureClients() { return { targetCount: 1, added: [client] }; },
      async reportVideoError(error) { throw error; },
      streamVideoToClients(...args) {
        transfers.push(name);
        const task = CodexSkinBridge.prototype.streamVideoToClients.apply(this, args);
        tasks.push(task);
        return task;
      },
    });
    return value;
  }
  const first = bridge('first');
  await first.injectCurrent({ reuseExisting: true });
  await Promise.all(tasks);
  const video = host.video();
  video.currentTime = 27;
  const second = bridge('second');
  const result = await second.injectCurrent({ reuseExisting: true });
  await Promise.all(tasks);
  assert.equal(result[0].reused, true);
  assert.deepEqual(transfers, ['first']);
  assert.equal(host.video(), video);
  assert.equal(video.currentTime, 27);
  assert.equal(second.active.panelOpacity, first.active.panelOpacity);
});

test('document restoration waits for Codex DOM and never installs into child frames', async () => {
  const host = renderer();
  let registered;
  const client = {
    async call(method, params) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        registered = params.source;
        return { identifier: 'restore' };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { installed: true } } };
      return {};
    },
  };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', active: { ...settings, mode: 'preview' },
    clients: new Map([['main', client]]),
    async ensureClients() { return { targetCount: 1, added: [client] }; },
  });
  await bridge.injectCurrent();
  const root = host.document.documentElement;
  host.document.documentElement = null;
  host.document.readyState = 'loading';
  host.window.top = {};
  assert.doesNotThrow(() => host.evaluate(registered));
  assert.equal(host.window.__codexWallpaperRuntime, undefined);
  host.window.top = host.window;
  assert.doesNotThrow(() => host.evaluate(registered));
  assert.equal(host.window.__codexWallpaperRuntime, undefined);
  host.document.documentElement = root;
  host.document.readyState = 'complete';
  host.document.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(host.window.__codexWallpaperRuntime.config.currentId, 'one');
  const layer = host.document.getElementById('codex-wallpaper-engine-skin');
  host.evaluate(registered);
  assert.equal(host.document.getElementById(layer.id), layer);
});

test('page reload resumes the restored Blob player instead of leaving an empty shell', async () => {
  let host = renderer();
  const file = join(mkdtempSync(join(tmpdir(), 'skin-reload-')), 'video.mp4');
  writeFileSync(file, 'abc');
  let registered;
  const tasks = [];
  const client = {
    async call(method, params) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        registered = params.source;
        return { identifier: 'restore' };
      }
      if (method === 'Runtime.evaluate') return { result: { value: host.evaluate(params.expression) } };
      return {};
    },
  };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', active: { ...settings, videoPath: file, videoBytes: 3 },
    clients: new Map([['main', client]]), streamGeneration: 1,
    async ensureClients() { return { targetCount: 1, added: [] }; },
    async reportVideoError(error) { throw error; },
    streamVideoToClients(...args) {
      const task = CodexSkinBridge.prototype.streamVideoToClients.apply(this, args);
      tasks.push(task);
      return task;
    },
  });
  await bridge.injectCurrent();
  await Promise.all(tasks);
  host = renderer();
  host.window.top = host.window;
  host.document.readyState = 'complete';
  host.evaluate(registered);
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().videoLoading, true);
  await bridge.handleClientEvent({ method: 'Page.loadEventFired' }, client);
  await Promise.all(tasks);
  assert.equal(host.window.__codexWallpaperRuntime.snapshot().videoLoading, false);
  assert.ok(host.video().src);
  const count = tasks.length;
  await bridge.handleClientEvent({ method: 'Page.loadEventFired' }, client);
  assert.equal(tasks.length, count, 'A healthy player must not transfer again.');
  host.install({ ...settings, controllerId: 'other', reuseExisting: true });
  await bridge.handleClientEvent({ method: 'Page.loadEventFired' }, client);
  assert.equal(host.window.__codexWallpaperRuntime.config.controllerId, 'other');
});

test('reconnecting after an app restart removes retired CDP targets', async t => {
  const originalWebSocket = globalThis.WebSocket;
  class DebugSocket extends EventTarget {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 1;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data) {
      const message = JSON.parse(data);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: message.id, result: {} }),
      })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = DebugSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{
      id: 'new-app', type: 'page', url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/new-app',
    }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const file = join(mkdtempSync(join(tmpdir(), 'skin-reconnect-')), 'state.json');
  const bridge = new CodexSkinBridge({ cdpPort: server.address().port, stateFile: file, restoreIntervalMs: 60_000 });
  t.after(() => bridge.disconnect());
  let retiredClosed = false;
  bridge.clients.set('old-app', {
    url: 'ws://127.0.0.1/old-app', socket: { readyState: 3 },
    close() { retiredClosed = true; },
    call() { throw new Error('Retired target was contacted.'); },
  });
  const connected = await bridge.ensureClients();
  assert.equal(connected.targetCount, 1);
  assert.equal(connected.added.length, 1);
  assert.equal(bridge.clients.size, 1);
  assert.equal(bridge.clients.has('old-app'), false);
  assert.equal(retiredClosed, true);
});

test('automatic restore requests reuse, and only the current controller handles selection', async () => {
  const calls = [];
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'second', saved: { id: 'one' }, active: null, restoreInFlight: false,
    async debugStatus() { return { available: true }; },
    async apply(...args) { calls.push(args); },
    selectionTask: Promise.resolve(),
  });
  await bridge.restoreSaved();
  assert.equal(calls[0][1]?.reuseExisting, true);
  calls.length = 0;
  bridge.active = { currentId: 'one' };
  for (const controllerId of ['first', 'second']) {
    bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
      name: 'codexSkinCommand', payload: JSON.stringify({ action: 'select', id: 'two', controllerId }),
    } });
  }
  await bridge.selectionTask;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].id, 'two');
});

test('selection is claimed once by a live controller even when the remembered owner is gone', async () => {
  const host = renderer();
  host.install({ ...settings, controllerId: 'gone' });
  finishVideo(host);
  const video = host.video();
  video.currentTime = 3600;
  const source = host.document.getElementById('codex-wallpaper-engine-skin-controls').querySelector('select');
  source.value = 'two';
  source.dispatchEvent(new Event('change'));
  const command = host.commands.at(-1);
  const applied = [];
  const client = {
    async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; },
  };
  const bridges = ['live-one', 'live-two'].map(controllerId => Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId, active: { ...settings }, selectionTask: Promise.resolve(),
    async apply(options, behavior) { applied.push({ controllerId, options, behavior }); },
    async reportVideoError(error) { throw error; },
  }));
  for (const bridge of bridges) {
    bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
      name: 'codexSkinCommand', payload: JSON.stringify(command),
    } }, client);
  }
  await Promise.all(bridges.map(bridge => bridge.selectionTask));
  assert.equal(applied.length, 1, 'A dead remembered owner must not strand the request.');
  assert.equal(applied[0].options.id, 'two');
  assert.equal(applied[0].options.panelOpacity, settings.panelOpacity);
  assert.equal(applied[0].behavior.selectionRequestId, command.requestId);
  assert.equal(host.window.__codexWallpaperRuntime.config.controllerId, applied[0].controllerId);
  assert.equal(host.video(), video, 'Claiming controls must not rebuild the wallpaper.');
  assert.equal(video.currentTime, 3600);
});

test('a newer selection supersedes queued requests and prevents late wallpaper installation', async () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const video = host.video();
  const source = host.document.getElementById('codex-wallpaper-engine-skin-controls').querySelector('select');
  source.value = 'two';
  source.dispatchEvent(new Event('change'));
  const older = host.commands.at(-1);
  source.value = 'one';
  source.dispatchEvent(new Event('change'));
  const newer = host.commands.at(-1);
  assert.notEqual(older.requestId, newer.requestId);
  const applied = [];
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'live', active: { ...settings }, selectionTask: Promise.resolve(),
    async apply(options) { applied.push(options); },
    async reportVideoError(error) { throw error; },
  });
  const client = {
    async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; },
  };
  for (const command of [older, newer]) {
    bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
      name: 'codexSkinCommand', payload: JSON.stringify(command),
    } }, client);
  }
  await bridge.selectionTask;
  assert.deepEqual(applied.map(options => options.id), ['one']);
  const result = host.install({ ...settings, currentId: 'two', selectionRequestId: older.requestId });
  assert.equal(result.superseded, true);
  assert.equal(host.video(), video);
  assert.equal(host.window.__codexWallpaperRuntime.config.currentId, 'one');
});

test('a superseded selection does not register a stale reload script or transfer video', async () => {
  const calls = [];
  const client = {
    async call(method) {
      calls.push(method);
      return { result: { value: { superseded: true } } };
    },
  };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'live', active: { ...settings }, clients: new Map([['main', client]]),
    async ensureClients() { return { targetCount: 1, added: [] }; },
    streamVideoToClients() { throw new Error('Superseded requests must not transfer.'); },
  });
  const result = await bridge.injectCurrent({ selectionRequestId: 'old' });
  assert.equal(result[0].superseded, true);
  assert.deepEqual(calls, ['Runtime.evaluate']);
});

test('disconnect hands controls back without removing the player or saved state', async () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const video = host.video();
  host.install({ ...settings, controllerId: 'second', reuseExisting: true });
  let closed = false;
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'second', streamGeneration: 0,
    clients: new Map([['target', {
      async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; },
      close() { closed = true; },
    }]]),
    sceneRuntime: { async close() {} },
  });
  await bridge.disconnect();
  assert.equal(closed, true);
  assert.equal(host.video(), video);
  assert.equal(host.window.__codexWallpaperRuntime.config.controllerId, 'first');
  assert.equal(host.window.__codexWallpaperRuntime.config.currentId, 'one');
});

test('Scene author edits are wrapped for the renderer and sent to the owning bridge for persistence', () => {
  const host = renderer();
  const messages = [];
  const child = { postMessage: value => messages.push(value) };
  const create = host.document.createElement;
  host.document.createElement = tag => {
    const element = create(tag);
    if (tag === 'iframe') element.contentWindow = child;
    return element;
  };
  host.install({ ...settings, mode: 'scene', scenePageUrl: 'http://127.0.0.1:4321/scene/test/index.html',
    userProperties: [{ key: 'enabled', label: 'Enabled', type: 'bool', value: true }],
    userPropertyValues: { enabled: true } });
  const ready = new Event('message');
  Object.assign(ready, { source: child, origin: 'http://127.0.0.1:4321', data: { type: 'codex-scene-ready' } });
  host.window.dispatchEvent(ready);
  const input = host.document.getElementById('codex-wallpaper-engine-skin-controls').querySelectorAll('input')
    .find(element => element.attributes['aria-label'] === 'Enabled');
  input.checked = false;
  input.dispatchEvent(new Event('change'));
  assert.equal(messages.at(-1).properties.enabled.value, false);
  assert.equal(host.commands.at(-1).settings.userPropertyValues.enabled, false);
  const file = join(mkdtempSync(join(tmpdir(), 'skin-props-')), 'state.json');
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', stateFile: file, active: {
      currentId: 'one', userProperties: [{ key: 'enabled', type: 'bool', value: true }],
      userPropertyValues: { enabled: true }, sourceOptions: settings.sourceOptions,
    },
  });
  bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
    name: 'codexSkinCommand', payload: JSON.stringify(host.commands.at(-1)),
  } });
  assert.equal(bridge.saved.userPropertyValues.enabled, false);
  assert.equal(bridge.saved.projectProperties.one.enabled, false);
  bridge.handleClientEvent({ method: 'Runtime.bindingCalled', params: {
    name: 'codexSkinCommand', payload: JSON.stringify({ action: 'settings', controllerId: 'first',
      currentId: 'old-wallpaper', settings: { userPropertyValues: { enabled: true } } }),
  } });
  assert.equal(bridge.active.currentId, 'one');
  assert.equal(bridge.active.userPropertyValues.enabled, false, 'Stale settings cannot change the newly selected project.');
});

test('fade holds one silent outgoing layer until new media is ready and releases its Blob', () => {
  const host = renderer();
  host.install(settings);
  finishVideo(host);
  const old = host.video();
  const blob = old.src;
  host.install({ ...settings, currentId: 'two', mode: 'preview', instanceId: 'next' });
  const outgoing = host.document.getElementById('codex-wallpaper-engine-skin-outgoing');
  const current = host.document.getElementById('codex-wallpaper-engine-skin');
  assert.ok(outgoing);
  assert.equal(outgoing.querySelector('video'), old);
  assert.equal(old.muted, true);
  assert.equal(old.paused, true);
  assert.equal(current.style.opacity, '0.001');
  assert.deepEqual(host.revoked, []);
  current.querySelector('img').dispatchEvent(new Event('load'));
  assert.equal(current.style.opacity, '1');
  for (const callback of host.timers.values()) callback();
  assert.equal(host.document.getElementById('codex-wallpaper-engine-skin-outgoing'), null);
  assert.deepEqual(host.revoked, [blob]);
  host.install({ ...settings, currentId: 'three', mode: 'preview', instanceId: 'third' });
  host.install({ ...settings, currentId: 'four', mode: 'preview', instanceId: 'fourth' });
  assert.equal(host.document.body.all().filter(element => element.id?.endsWith('-outgoing')).length, 1);
});

test('peer controllers preserve all per-project author values in the shared state file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'skin-shared-props-')), 'state.json');
  const first = Object.assign(Object.create(CodexSkinBridge.prototype), {
    stateFile: file, active: { currentId: 'one', userPropertyValues: { enabled: false } },
  });
  const peer = Object.assign(Object.create(CodexSkinBridge.prototype), {
    stateFile: file, active: { currentId: 'two', userPropertyValues: { enabled: true } },
  });
  first.persistActive();
  peer.persistActive();
  first.persistActive();
  assert.equal(first.saved.projectProperties.one.enabled, false);
  assert.equal(first.saved.projectProperties.two.enabled, true);
});

test('document restoration refreshes edited settings once without rebuilding healthy playback', async () => {
  const host = renderer();
  host.install({ ...settings, mode: 'preview', userPropertyValues: { enabled: true } });
  let refreshes = 0;
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', active: { ...settings, mode: 'preview', userPropertyValues: { enabled: false } },
    async injectCurrent({ reuseExisting }) { assert.equal(reuseExisting, false); refreshes++; },
  });
  const client = { async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; } };
  await bridge.restoreClient(client);
  assert.equal(refreshes, 1);
  host.window.__codexWallpaperRuntime.config.userPropertyValues.enabled = false;
  await bridge.restoreClient(client);
  assert.equal(refreshes, 1);
});

test('document restoration uses shared saved values instead of a stale elected controller', async () => {
  const host = renderer();
  const file = join(mkdtempSync(join(tmpdir(), 'skin-shared-reload-')), 'state.json');
  const stale = { ...settings, mode: 'preview', userPropertyValues: { enabled: true } };
  host.install(stale);
  const saved = { enabled: true, id: settings.currentId,
    userPropertyValues: { enabled: false } };
  writeFileSync(file, JSON.stringify(saved), 'utf8');
  const calls = [];
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'first', stateFile: file, active: stale,
    async apply(value, behavior) {
      calls.push({ value, behavior });
      this.active = { ...stale, ...value, currentId: value.id };
      host.install(this.active);
    },
  });
  const client = { async call(_method, params) { return { result: { value: host.evaluate(params.expression) } }; } };
  await bridge.restoreClient(client);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.userPropertyValues.enabled, false);
  assert.equal(calls[0].behavior.reuseExisting, false);
  await bridge.restoreClient(client);
  assert.equal(calls.length, 1, 'A matching, healthy player is not rebuilt.');
  saved.id = 'two';
  writeFileSync(file, JSON.stringify(saved), 'utf8');
  await bridge.restoreClient(client);
  assert.equal(calls.at(-1).value.id, 'two', 'The saved wallpaper also supersedes captured selection.');
});
