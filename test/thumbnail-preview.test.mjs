import test from 'node:test';
import assert from 'node:assert/strict';
import { ftruncateSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { SceneRuntimeServer } from '../src/scene-runtime.mjs';
import { CodexSkinBridge } from '../src/codex-skin.mjs';

test('local preview transfers accept only registered identities and bounded files', async t => {
  const projectDir = mkdtempSync(join(tmpdir(), 'local-thumbnail-'));
  const previewPath = join(projectDir, 'preview.png');
  writeFileSync(previewPath, 'registered-preview');
  const runtime = new SceneRuntimeServer();
  t.after(() => runtime.close());
  const [source] = await runtime.librarySources([
    { id: 'registered', title: 'Preview', type: 'scene', skinMode: 'scene', projectDir, previewPath },
  ]);
  assert.equal(runtime.readLibraryPreview(source.id, source.thumbnailUrl),
    'data:image/png;base64,' + Buffer.from('registered-preview').toString('base64'));
  for (const [id, url] of [
    ['other', source.thumbnailUrl],
    [source.id, source.thumbnailUrl.replace('/preview/', '/preview/../')],
    [source.id, 'file:///' + previewPath],
    [source.id, source.thumbnailUrl + '?file=' + previewPath],
  ]) assert.throws(() => runtime.readLibraryPreview(id, url), /not registered/);
  const descriptor = openSync(previewPath, 'r+');
  try { ftruncateSync(descriptor, 6 * 1024 * 1024 + 1); }
  finally { closeSync(descriptor); }
  assert.throws(() => runtime.readLibraryPreview(source.id, source.thumbnailUrl), /6 MiB/);
});

test('thumbnail replies are scoped to the originating owner, instance and library identity', async () => {
  const source = { id: 'one', thumbnailUrl: 'http://127.0.0.1:1234/preview/token' };
  let reads = 0;
  const replies = [];
  const runtime = { config: { controllerId: 'owner', instanceId: 'current', sourceOptions: [source] },
    sidebar: { resolveThumbnail: value => replies.push(value) } };
  const window = { __codexWallpaperRuntime: runtime };
  window.top = window;
  const client = { async call(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: runInNewContext(params.expression, {
      window, location: { href: 'app://-/index.html' },
    }) } };
  } };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'owner', active: { instanceId: 'current', sourceOptions: [source] },
    sceneRuntime: { readLibraryPreview(id, url) {
      reads++;
      assert.equal(id, source.id);
      assert.equal(url, source.thumbnailUrl);
      return 'data:image/png;base64,AA==';
    } },
  });
  const command = { action: 'preview-thumbnail', controllerId: 'owner', instanceId: 'current',
    requestId: 'request', id: source.id, url: source.thumbnailUrl };
  const send = command => bridge.handleClientEvent({ method: 'Runtime.bindingCalled',
    params: { name: 'codexSkinCommand', payload: JSON.stringify(command) } }, client);
  await send({ ...command, controllerId: 'foreign' });
  await send({ ...command, instanceId: 'retired' });
  await send({ ...command, id: 'other' });
  await send({ ...command, url: 'file:///secret.png' });
  assert.equal(reads, 0);
  await send(command);
  assert.equal(reads, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].dataUrl, 'data:image/png;base64,AA==');
  runtime.config.instanceId = 'new';
  await send(command);
  assert.equal(replies.length, 1, 'A late reply must not populate a new renderer.');
  runtime.config.instanceId = 'current';
  bridge.sceneRuntime.readLibraryPreview = () => { throw new Error('Preview file missing'); };
  await send(command);
  assert.equal(replies.at(-1).error, 'Preview file missing');
});

test('thumbnail fallback accepts the retained renderer instance after a bridge handoff', async () => {
  const source = { id: 'one', thumbnailUrl: 'http://127.0.0.1:1234/preview/token' };
  const replies = [];
  const runtime = { config: { controllerId: 'successor', instanceId: 'retained', sourceOptions: [source] },
    sidebar: { resolveThumbnail: value => replies.push(value) } };
  const window = { __codexWallpaperRuntime: runtime };
  window.top = window;
  const client = { skinInstanceId: 'retained', async call(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: runInNewContext(params.expression, {
      window, location: { href: 'app://-/index.html' },
    }) } };
  } };
  let reads = 0;
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'successor', active: { instanceId: 'new-bridge', sourceOptions: [source] },
    sceneRuntime: { readLibraryPreview() { reads++; return 'data:image/png;base64,AA=='; } },
  });
  const send = instanceId => bridge.handleClientEvent({ method: 'Runtime.bindingCalled',
    params: { name: 'codexSkinCommand', payload: JSON.stringify({
      action: 'preview-thumbnail', controllerId: 'successor', instanceId,
      requestId: 'request', id: source.id, url: source.thumbnailUrl,
    }) } }, client);
  await send('retained');
  assert.equal(reads, 1, 'The live renderer ID must not be rejected in favor of the bridge-generated ID.');
  assert.equal(replies.length, 1);
  await send('new-bridge');
  assert.equal(reads, 1, 'A bridge ID is not proof of ownership of the retained renderer.');
  runtime.config.instanceId = 'replacement';
  await send('retained');
  assert.equal(replies.length, 1, 'Late replies must still be rejected after renderer replacement.');
});

test('document restoration updates the client instance used by thumbnail replies', async () => {
  const source = { id: 'one', thumbnailUrl: 'http://127.0.0.1:1234/preview/token' };
  const replies = [];
  const runtime = { config: { controllerId: 'owner', instanceId: 'new-document', currentId: 'one',
      sourceOptions: [source] },
    snapshot: () => ({ instanceId: 'new-document', settings: {} }),
    sidebar: { resolveThumbnail: result => replies.push(result) } };
  const window = { __codexWallpaperRuntime: runtime };
  window.top = window;
  const client = { skinInstanceId: 'retired-document', async call(_method, params) {
    return { result: { value: runInNewContext(params.expression, {
      window, location: { href: 'app://-/index.html' },
    }) } };
  } };
  const bridge = Object.assign(Object.create(CodexSkinBridge.prototype), {
    controllerId: 'owner', active: { instanceId: 'new-document', currentId: 'one', mode: 'scene', sourceOptions: [source] },
    savedSettings: () => ({ id: 'one' }),
    sceneRuntime: { readLibraryPreview: () => 'data:image/png;base64,AA==' },
  });
  await bridge.restoreClient(client);
  assert.equal(client.skinInstanceId, 'new-document');
  await bridge.replyThumbnail({ instanceId: 'new-document', requestId: 'new-request',
    id: 'one', url: source.thumbnailUrl }, client);
  assert.equal(replies.length, 1);
});

test('the Scene snapshot adapter accepts opaque black pixels and reports capture exceptions', async t => {
  const projectDir = mkdtempSync(join(tmpdir(), 'black-preview-'));
  const filePath = join(projectDir, 'scene.pkg');
  const projectPath = join(projectDir, 'project.json');
  writeFileSync(filePath, 'fixture');
  writeFileSync(projectPath, '{}');
  const server = new SceneRuntimeServer();
  t.after(() => server.close());
  const urls = await server.prepare({ type: 'scene', projectDir, filePath, projectPath });
  const source = await (await fetch(urls.sceneRendererUrl)).text();
  const adapter = source.slice(source.lastIndexOf('export function mountCodexScene')).replace('export function', 'function');
  const wp = { setWallpaper() {}, capture: () => 'data:image/png;base64,AA==' };
  const controller = runInNewContext(adapter + '\nmountCodexScene({}, {})', {
    Te: {}, window: { __wp: wp },
    requestAnimationFrame: callback => callback(),
    document: { querySelector: () => ({ width: 2560, height: 1440 }),
      createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {},
        getImageData: () => ({ data: [0, 0, 0, 255] }) }) }) },
  });
  const snapshot = await controller.snapshot();
  assert.equal(snapshot.dataUrl, 'data:image/png;base64,AA==');
  wp.capture = () => { throw new Error('Capture rejected'); };
  await assert.rejects(controller.snapshot(), /Capture rejected/);
});
