import test from 'node:test';
import assert from 'node:assert/strict';
import { wallpaperCrop, installSkinPresentation } from '../src/skin-crop.mjs';
import { runInNewContext } from 'node:vm';

test('crop keeps the window aspect and undistorted source for both fit modes', () => {
  for (const [width, height] of [[2560, 1440], [576, 1024], [1024, 1024]]) {
    for (const [viewportWidth, viewportHeight] of [[1707, 1019], [390, 844], [800, 320]]) {
      for (const fitMode of ['cover', 'contain']) {
        for (const zoom of [100, 200, 400]) {
          const crop = wallpaperCrop({ width, height, viewportWidth, viewportHeight, fitMode, zoom, positionX: 68, positionY: 24 });
          assert.ok(Math.abs(crop.width * width / (crop.height * height) - viewportWidth / viewportHeight) < 1e-9);
          assert.ok(Math.abs((viewportWidth / crop.width) / (viewportHeight / crop.height) - width / height) < 1e-9);
          assert.equal(crop.x, (1 - crop.width) * (crop.width >= 1 ? .5 : .68));
          if (zoom === 100 && fitMode === 'contain') {
            assert.ok(crop.width >= 1 && crop.height >= 1);
          }
        }
      }
    }
  }
});

test('source geometry is unknown until native dimensions arrive', () => {
  assert.equal(wallpaperCrop({ width: 0, height: 0, viewportWidth: 1280, viewportHeight: 816 }), null);
  assert.equal(wallpaperCrop({ width: 2560, height: 1440, viewportWidth: 0, viewportHeight: 816 }), null);
});

function scenePresentation({ hidden = false } = {}) {
  const host = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    hidden, hasFocus: () => true,
    createElement: () => ({ content: {} }),
  });
  const panel = { style: { display: 'block' }, children: [],
    querySelector: () => null, querySelectorAll: () => [] };
  const controls = { children: [null, panel] };
  document.getElementById = () => controls;
  const requests = [];
  const ticks = [];
  let sidebarOptions;
  host.setInterval = callback => { ticks.push(callback); return ticks.length; };
  host.clearInterval = () => {};
  const media = { tagName: 'IFRAME', style: {}, getAttribute: () => '', setAttribute() {},
    removeAttribute() {}, contentWindow: { postMessage: message => requests.push(message) },
    addEventListener() {}, removeEventListener() {} };
  const runtime = {
    config: { currentId: 'scene', mode: 'scene', instanceId: 'one', controllerId: 'owner',
      sourceOptions: [{ id: 'scene', sourceWidth: 2560, sourceHeight: 1440 }],
      scenePageUrl: 'http://127.0.0.1:4321/scene/one/index.html', fitMode: 'contain', zoom: 100,
      positionX: 50, positionY: 50 },
    controllers: ['owner'], sceneStatus: { state: 'ready' }, layer: { style: {} },
    getMedia: () => media, snapshot: () => ({ settings: {}, mode: 'scene' }),
  };
  host.__codexWallpaperRuntime = runtime;
  const context = {
    window: host, document, innerWidth: 1280, innerHeight: 816, URL,
    requestAnimationFrame: () => assert.fail('A ready preview request must not wait on parent animation frames.'),
    MutationObserver: class { observe() {} disconnect() {} },
    options: { runtime, assets: {}, calculateCrop: wallpaperCrop,
      installFeatures: () => Object.assign(() => {}, { schedule() {} }),
      installSidebar: options => { sidebarOptions = options;
        return { refresh() {}, refreshLibrary() {}, updateCrop() {}, updateStatus() {}, cleanup() {}, setOpen() {} }; } },
  };
  const remount = () => runInNewContext(`(${installSkinPresentation.toString()})(options)`, context);
  const api = remount();
  const respond = data => {
    const event = new Event('message');
    Object.assign(event, { origin: 'http://127.0.0.1:4321', source: media.contentWindow, data });
    host.dispatchEvent(event);
  };
  return { api, requests, ticks, respond, retry: () => sidebarOptions.onRefreshPreview(),
    error: () => sidebarOptions.getCropPreviewError(), media, remount };
}

test('a slow Scene snapshot stays valid across later preview timer ticks', () => {
  const host = scenePresentation();
  const first = host.requests[0];
  host.ticks[0]();
  host.ticks[0]();
  host.respond({ type: 'codex-scene-snapshot', requestId: first.requestId,
    dataUrl: 'data:image/png;base64,AA==', sourceWidth: 2560, sourceHeight: 1440 });
  assert.ok(host.api.getCropPreview(), 'The response to the still-running first capture must be accepted.');
  assert.equal(host.requests.length, 1, 'Do not replace an outstanding request with a new ID.');
});

test('snapshot errors are separate from playback and retry only on explicit refresh', () => {
  const host = scenePresentation();
  const first = host.requests[0];
  host.respond({ type: 'codex-scene-snapshot-error', requestId: 'unrelated', message: 'ignored' });
  assert.equal(host.error(), null);
  host.respond({ type: 'codex-scene-snapshot-error', requestId: first.requestId, message: 'No canvas pixels' });
  assert.equal(host.error(), 'No canvas pixels');
  host.ticks[0]();
  assert.equal(host.requests.length, 1);
  host.retry();
  assert.equal(host.requests.length, 2);
  assert.equal(host.error(), null);
  host.respond({ type: 'codex-scene-snapshot', requestId: host.requests[1].requestId,
    dataUrl: 'data:image/png;base64,AA==', sourceWidth: 2560, sourceHeight: 1440 });
  assert.ok(host.api.getCropPreview());
  host.api.cleanup();
  host.ticks[0]();
  assert.equal(host.requests.length, 2, 'Disposed presentation must not request captures.');
});

test('ready Scene previews can be requested while parent animation frames are suspended', () => {
  const host = scenePresentation({ hidden: true });
  assert.equal(host.requests.length, 1);
  host.respond({ type: 'codex-scene-snapshot', requestId: host.requests[0].requestId,
    dataUrl: 'data:image/png;base64,AA==', sourceWidth: 2560, sourceHeight: 1440 });
  assert.ok(host.api.getCropPreview());
});

test('reinstalling the sidebar does not reuse a renderer snapshot request ID', () => {
  const host = scenePresentation();
  const first = host.requests[0].requestId;
  host.api.cleanup();
  const next = host.remount();
  assert.notEqual(host.requests[1].requestId, first);
  host.respond({ type: 'codex-scene-snapshot', requestId: first,
    dataUrl: 'data:image/png;base64,AA==', sourceWidth: 2560, sourceHeight: 1440 });
  assert.equal(next.getCropPreview(), null);
  host.respond({ type: 'codex-scene-snapshot', requestId: host.requests[1].requestId,
    dataUrl: 'data:image/png;base64,AA==', sourceWidth: 2560, sourceHeight: 1440 });
  assert.ok(next.getCropPreview());
});

test('a UI-only upgrade retains the same successful native Scene preview', () => {
  const host = scenePresentation();
  const url = 'data:image/png;base64,AA==';
  host.respond({ type: 'codex-scene-snapshot', requestId: host.requests[0].requestId,
    dataUrl: url, sourceWidth: 2560, sourceHeight: 1440 });
  const next = host.remount();
  assert.equal(next.getCropPreview().url, url);
  assert.equal(host.requests.length, 1);
});
