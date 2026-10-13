import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildNativeThemeString, clearSavedSkinState, CodexSkinBridge, isCodexTarget, isPathInside, makeInjectionScript, readSavedSkinState, selectEmbeddableMedia, writeSavedSkinState } from '../src/codex-skin.mjs';
import { SceneRuntimeServer } from '../src/scene-runtime.mjs';
import { enumerateWallpaperSources, librariesFromVdfText, readProject, normalizeUserProperties, resolveUserPropertyValues } from '../src/wallpaper-engine.mjs';

test('parses the Steam library that owns Wallpaper Engine', () => {
  const vdf = `
"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
    "apps" { "431960" "1" }
  }
  "1"
  {
    "path" "D:\\\\SteamLibrary"
    "apps" { "999" "1" }
  }
}`;
  assert.deepEqual(librariesFromVdfText(vdf), ['C:\\Program Files (x86)\\Steam']);
});

test('parses Steam library app sizes rather than assuming an installed flag', () => {
  const vdf = String.raw`
"libraryfolders"
{
  "0"
  {
    "path" "E:\\steam"
    "apps" { "228980" "710825723" }
  }
  "1"
  {
    "path" "G:\\SteamLibrary"
    "apps"
    {
      "431960" "826275581"
    }
  }
}`;
  assert.deepEqual(librariesFromVdfText(vdf), ['G:\\SteamLibrary']);
});

test('classifies video and scene preview projects for Codex rendering', () => {
  const root = mkdtempSync(join(tmpdir(), 'we-codex-'));
  const installDir = join(root, 'wallpaper_engine');
  const videoDir = join(installDir, 'projects', 'myprojects', 'aurora');
  const sceneDir = join(root, 'steamapps', 'workshop', 'content', '431960', '123456');
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(sceneDir, { recursive: true });
  writeFileSync(join(videoDir, 'aurora.mp4'), 'video');
  writeFileSync(join(sceneDir, 'scene.pkg'), 'pkg');
  writeFileSync(join(sceneDir, 'preview.jpg'), 'preview');
  writeFileSync(join(videoDir, 'project.json'), JSON.stringify({ title: 'Aurora', type: 'video', file: 'aurora.mp4' }));
  writeFileSync(join(sceneDir, 'project.json'), JSON.stringify({
    title: 'City',
    type: 'scene',
    file: 'scene.pkg',
    preview: 'preview.jpg',
    general: { properties: { enabled: { type: 'bool', text: 'Enabled', value: true } } },
  }));

  assert.equal(readProject(videoDir, 'local').skinMode, 'video');
  assert.equal(readProject(sceneDir, 'workshop').skinMode, 'scene');
  assert.deepEqual(readProject(sceneDir, 'workshop').userProperties, [{
    key: 'enabled', label: 'Enabled', type: 'bool', value: true,
  }]);
  const projects = enumerateWallpaperSources({ installDir, libraryDirs: [root] });
  assert.deepEqual(projects.map((item) => [item.id, item.skinMode]).sort(), [['123456', 'scene'], ['local:aurora', 'video']]);
});

test('marks author-declared static titles and actual image projects without treating thumbnails as static media', async t => {
  const root = mkdtempSync(join(tmpdir(), 'we-library-category-'));
  const staticDir = join(root, 'static-image');
  const sceneDir = join(root, 'scene-preview');
  const gifDir = join(root, 'animated-gif');
  mkdirSync(staticDir); mkdirSync(sceneDir); mkdirSync(gifDir);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000780000004380802000000', 'hex');
  writeFileSync(join(staticDir, 'wallpaper.png'), png);
  writeFileSync(join(staticDir, 'project.json'), JSON.stringify({ title: 'Artwork', type: 'image', file: 'wallpaper.png' }));
  writeFileSync(join(sceneDir, 'preview.jpg'), 'thumbnail-only');
  writeFileSync(join(sceneDir, 'project.json'), JSON.stringify({ title: 'Static Scene', type: 'scene', file: 'scene.pkg', preview: 'preview.jpg' }));
  writeFileSync(join(gifDir, 'wallpaper.gif'), Buffer.from('47494638396102000300', 'hex'));
  writeFileSync(join(gifDir, 'project.json'), JSON.stringify({ title: 'Animated GIF', type: 'image', file: 'wallpaper.gif' }));
  const image = readProject(staticDir);
  const titled = readProject(sceneDir);
  const gif = readProject(gifDir);
  assert.equal(image.isStatic, true);
  assert.equal(image.skinMode, 'preview');
  assert.equal(image.previewPath, join(staticDir, 'wallpaper.png'));
  assert.deepEqual([image.sourceWidth, image.sourceHeight], [1920, 1080]);
  assert.equal(titled.isStatic, true);
  assert.deepEqual([titled.sourceWidth, titled.sourceHeight], [null, null]);
  assert.equal(gif.isStatic, false);
  assert.equal(gif.previewPath, join(gifDir, 'wallpaper.gif'));
  assert.deepEqual([gif.sourceWidth, gif.sourceHeight], [2, 3]);
  const runtime = new SceneRuntimeServer();
  t.after(() => runtime.close());
  const sources = await runtime.librarySources([
    image,
    { ...titled, skinMode: 'preview' },
    gif,
    { id: 'thumbnail-only', title: 'Scene', type: 'scene', source: 'local', skinMode: 'preview', projectDir: sceneDir, previewPath: join(sceneDir, 'preview.jpg') },
  ]);
  assert.deepEqual(sources.map(source => [source.category, source.sourceWidth, source.sourceHeight]), [
    ['static', 1920, 1080], ['static', null, null], ['preview', 2, 3], ['preview', null, null],
  ]);
});

test('normalizes supported Scene author properties and ignores unsupported types', () => {
  const properties = normalizeUserProperties({
    enabled: { text: '启用特效', type: 'bool', value: true },
    amount: { text: '粒子数量', type: 'slider', value: 0.4, min: 0, max: 1, step: 0.1 },
    tint: { text: '颜色', type: 'color', value: '1 0.5 0' },
    mode: { text: '模式', type: 'combo', value: 'soft', options: [{ label: '柔和', value: 'soft' }, { label: '强烈', value: 'hard' }] },
    title: { text: '标题', type: 'text', value: 'Scene' },
    file: { text: '文件', type: 'file', value: 'secret.txt' },
  });
  assert.deepEqual(properties.map(({ key, type }) => [key, type]), [
    ['enabled', 'bool'], ['amount', 'slider'], ['tint', 'color'], ['mode', 'combo'], ['title', 'text'],
  ]);
  assert.deepEqual(resolveUserPropertyValues(properties, { enabled: false, amount: 2, mode: 'hard', unknown: 'ignored' }), {
    enabled: false, amount: 1, tint: '1 0.5 0', mode: 'hard', title: 'Scene',
  });
  const longKey = 'author_property_'.repeat(20);
  assert.equal(normalizeUserProperties({ [longKey]: { type: 'bool', value: true } })[0].key, longKey);
});

test('builds a native Codex theme import string', () => {
  const value = buildNativeThemeString({ accent: '#112233', surface: '#181818', ink: '#FFFFFF' });
  assert.match(value, /^codex-theme-v1:/);
  const payload = JSON.parse(value.slice('codex-theme-v1:'.length));
  assert.equal(payload.theme.accent, '#112233');
  assert.equal(payload.theme.opaqueWindows, false);
});

test('builds an injection script without embedding filesystem paths', () => {
  const script = makeInjectionScript({ mediaUrl: 'http://127.0.0.1:4321/content/token/video.mp4', mode: 'video' });
  assert.match(script, /codex-wallpaper-engine-skin/);
  assert.match(script, /皮肤调整/);
  assert.match(script, /127\.0\.0\.1:4321/);
  assert.match(script, /id \+ '-blur'/);
  assert.match(script, /body>#root/);
  assert.match(script, /backdropFilter/);
  assert.match(script, /data-radix-popper-content-wrapper/);
  assert.match(script, /background-color:rgba\(20,22,26,\.94\)/);
  assert.doesNotMatch(script, /body>div:not\(/);
  assert.doesNotMatch(script, /data-radix-popper-content-wrapper.*backdrop-filter/);
  assert.doesNotMatch(script, /\[class\*="bg-surface"\]/);
  assert.doesNotMatch(script, /[A-Z]:\\\\/);
});

test('removes only the thread footer backdrop layers without restyling the composer', () => {
  const script = makeInjectionScript({ mediaUrl: 'data:image/png;base64,AA==', mode: 'image' });
  const selector = '[data-app-action-timeline-scroll] [data-thread-user-message-navigation-content] ~ .sticky.pointer-events-none > .bg-gradient-to-t.from-surface';
  assert.ok(script.includes(selector + '{background-image:none!important}'));
  const surface = '[data-app-action-timeline-scroll] [data-thread-scroll-footer] > div.pointer-events-none.absolute.bg-surface';
  assert.ok(script.includes(surface + '{background-color:transparent!important}'));
  assert.doesNotMatch(script, /\[data-codex-composer-root\]\s*\{/);
  assert.doesNotMatch(script, /\[data-composer-surface-variant\]\s*\{/);
  assert.doesNotMatch(script, /\[class\*="bg-(?:surface|elevated)"\]/);
});

test('builds a WebWallGL Scene injection with a preview fallback', () => {
  const script = makeInjectionScript({
    mediaUrl: 'data:image/jpeg;base64,AA==',
    mode: 'scene',
    sceneRendererUrl: 'http://127.0.0.1:4321/renderer.js',
    scenePageUrl: 'http://127.0.0.1:4321/scene/token/index.html',
    sceneSourceUrl: 'http://127.0.0.1:4321/scene/token/scene.pkg',
    sceneProjectUrl: 'http://127.0.0.1:4321/scene/token/project.json',
  });
  assert.match(script, /scenePageUrl/);
  assert.match(script, /codex-scene-playback/);
  assert.doesNotMatch(script, /sceneSrcDoc|loadSceneFile|media\.contentWindow\?\.__wp/);
  assert.match(script, /codex-scene-ready/);
  assert.match(script, /codex-scene-error/);
  assert.match(script, /fallbackToPreview/);
  assert.match(script, /securitypolicyviolation/);
  assert.match(script, /已回退到预览图/);
});

test('includes Scene author properties in the injection and playback protocol', () => {
  const script = makeInjectionScript({
    mediaUrl: 'data:image/jpeg;base64,AA==',
    mode: 'scene',
    scenePageUrl: 'http://127.0.0.1:4321/scene/token/index.html',
    userProperties: [{ key: 'enabled', label: '启用', type: 'bool', value: true }],
    userPropertyValues: { enabled: false },
  });
  assert.match(script, /壁纸属性/);
  assert.match(script, /userPropertyValues/);
  assert.match(script, /codex-scene-playback/);
  assert.match(script, /Object\.entries\(cfg\.userPropertyValues\)/);
});

test('library previews use bounded project-local image URLs and never serve arbitrary paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'skin-library-preview-'));
  const preview = join(root, 'preview.png');
  writeFileSync(preview, 'png-fixture');
  const outside = join(mkdtempSync(join(tmpdir(), 'skin-outside-')), 'preview.png');
  writeFileSync(outside, 'not-allowed');
  const runtime = new SceneRuntimeServer();
  t.after(() => runtime.close());
  const sources = await runtime.librarySources([
    { id: 'good', title: 'Good', type: 'scene', skinMode: 'scene', projectDir: root, previewPath: preview },
    { id: 'outside', title: 'Outside', type: 'scene', skinMode: 'scene', projectDir: root, previewPath: outside },
    { id: 'web', title: 'Web preview', type: 'web', skinMode: 'web', projectDir: root, previewPath: preview },
  ]);
  assert.equal(sources[1].thumbnailUrl, null);
  assert.equal(sources[2].skinMode, 'preview');
  assert.deepEqual(sources[0].category, 'scene');
  assert.deepEqual([sources[0].sourceWidth, sources[0].sourceHeight], [null, null]);
  assert.doesNotMatch(sources[0].thumbnailUrl, /[A-Z]:\\/);
  const response = await fetch(sources[0].thumbnailUrl);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), 'png-fixture');
  assert.equal((await fetch(`${runtime.baseUrl}/preview/../../secret.txt`)).status, 404);
  assert.equal((await fetch(`${runtime.baseUrl}/preview/${'a'.repeat(32)}`)).status, 404);
});

test('serves registered Scene packages and the WebWallGL renderer over loopback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'we-scene-runtime-'));
  const projectPath = join(root, 'project.json');
  const packagePath = join(root, 'scene.pkg');
  writeFileSync(projectPath, JSON.stringify({ title: 'Test Scene', type: 'scene', file: 'scene.pkg' }));
  writeFileSync(packagePath, Buffer.from('scene-package'));

  const runtime = new SceneRuntimeServer();
  try {
    const urls = await runtime.prepare({
      type: 'scene',
      projectDir: root,
      projectPath,
      filePath: packagePath,
    });
    const renderer = await fetch(urls.sceneRendererUrl);
    assert.equal(renderer.status, 200);
    assert.match(renderer.headers.get('content-type') || '', /^text\/javascript/);
    const rendererSource = await renderer.text();
    assert.match(rendererSource, /loadSceneFile/);
    assert.match(rendererSource, /export function mountCodexScene/);
    assert.match(rendererSource, /Te\.onFirstFrame = callbacks\.onReady/);
    assert.match(rendererSource, /Te\.onSceneInfo = callbacks\.onSceneInfo/);
    assert.match(rendererSource, /updateWebProps/);
    assert.match(rendererSource, /snapshot\(\)/);
    assert.match(rendererSource, /remainingFrames = 120/);
    assert.match(rendererSource, /hasVisiblePixels/);

    const scenePage = await fetch(urls.scenePageUrl);
    assert.equal(scenePage.status, 200);
    assert.match(scenePage.headers.get('content-type') || '', /^text\/html/);
    assert.match(await scenePage.text(), /startScenePlayer/);
    const head = await fetch(urls.scenePageUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '');
    const player = await fetch(new URL('/scene-player.mjs', urls.scenePageUrl));
    assert.equal(player.status, 200);
    assert.match(await player.text(), /mountCodexScene/);

    const project = await fetch(urls.sceneProjectUrl);
    assert.equal(project.status, 200);
    assert.deepEqual(await project.json(), { title: 'Test Scene', type: 'scene', file: 'scene.pkg' });

    const scenePackage = await fetch(urls.sceneSourceUrl);
    assert.equal(scenePackage.status, 200);
    assert.equal(Buffer.from(await scenePackage.arrayBuffer()).toString(), 'scene-package');

    const unknown = await fetch(urls.sceneSourceUrl.replace(/\/[a-f0-9]{32}\//, '/00000000000000000000000000000000/'));
    assert.equal(unknown.status, 404);
  } finally {
    await runtime.close();
  }
});

test('initialized Scene runtime keeps serving its assets after plugin cache files are retired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'we-retired-runtime-'));
  const assets = join(root, 'webwallgl', 'assets');
  mkdirSync(assets, { recursive: true });
  const moduleFile = join(root, 'scene-runtime.mjs');
  writeFileSync(moduleFile, readFileSync(new URL('../src/scene-runtime.mjs', import.meta.url)));
  const files = [
    [join(root, 'scene-player.mjs'), 'export function startScenePlayer() {}'],
    [join(assets, 'renderer-DTLW1Gf0.js'), 'const Te = {}; // test renderer'],
    [join(assets, 'modulepreload-polyfill-B5Qt9EMX.js'), '// test polyfill'],
  ];
  for (const [file, contents] of files) writeFileSync(file, contents, 'utf8');
  const { SceneRuntimeServer: RetiredRuntime } = await import(pathToFileURL(moduleFile));
  const projectPath = join(root, 'project.json');
  const packagePath = join(root, 'scene.pkg');
  writeFileSync(projectPath, '{"type":"scene","file":"scene.pkg"}', 'utf8');
  writeFileSync(packagePath, 'test package', 'utf8');
  const runtime = new RetiredRuntime();
  try {
    const urls = await runtime.prepare({ type: 'scene', projectDir: root, projectPath, filePath: packagePath });
    for (const [file] of files) {
      assert.ok(isPathInside(root, file));
      unlinkSync(file);
    }
    const base = new URL(urls.scenePageUrl);
    for (const [path, expected] of [
      ['/scene-player.mjs', 'startScenePlayer'],
      ['/renderer.js', 'mountCodexScene'],
      ['/modulepreload-polyfill-B5Qt9EMX.js', 'test polyfill'],
    ]) {
      const response = await fetch(new URL(path, base));
      assert.equal(response.status, 200, `${path} must survive cache retirement.`);
      assert.match(await response.text(), new RegExp(expected));
      assert.equal((await fetch(new URL(path, base), { method: 'HEAD' })).status, 200);
    }
    assert.equal((await fetch(urls.sceneSourceUrl)).status, 200);
    assert.equal((await runtime.prepare({ type: 'scene', projectDir: root, projectPath, filePath: packagePath })).scenePageUrl, urls.scenePageUrl);
  } finally {
    await runtime.close();
  }
});

test('Scene page reports a failed player-module import instead of leaving the parent loading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'we-bootstrap-error-'));
  const projectPath = join(root, 'project.json');
  const filePath = join(root, 'scene.pkg');
  writeFileSync(projectPath, '{}', 'utf8');
  writeFileSync(filePath, 'test', 'utf8');
  const runtime = new SceneRuntimeServer();
  try {
    const urls = await runtime.prepare({ type: 'scene', projectDir: root, projectPath, filePath });
    const html = await (await fetch(urls.scenePageUrl)).text();
    const script = /<script type="module">([\s\S]+)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    assert.match(script, /\.catch\(/);
    const messages = [];
    const run = new Function('loadPlayer', 'parent', `return ${script.replace('import("/scene-player.mjs")', 'loadPlayer()')}`);
    await run(() => Promise.reject(new Error('Player module returned HTTP 404')), {
      postMessage(value, origin) { messages.push({ value, origin }); },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].value.type, 'codex-scene-error');
    assert.match(messages[0].value.message, /HTTP 404/);
    assert.equal(messages[0].origin, '*');
  } finally {
    await runtime.close();
  }
});

test('builds a timed frame animation', () => {
  const script = makeInjectionScript({
    mediaUrl: 'data:image/jpeg;base64,AA==',
    mediaFrames: ['data:image/jpeg;base64,AA==', 'data:image/jpeg;base64,AQ=='],
    frameDelayMs: 200,
    mode: 'frames',
  });
  assert.match(script, /__codexWallpaperFrameTimer/);
  assert.match(script, /frameIndex/);
  assert.match(script, /requestAnimationFrame/);
  assert.doesNotMatch(script.slice(script.indexOf("if (cfg.mode === 'frames' &&"), script.indexOf('layer.appendChild(media)')), /setInterval/);
});

test('builds full-video transfer and video-selection controls', () => {
  const script = makeInjectionScript({
    mediaUrl: 'data:image/gif;base64,R0lGODlh',
    mode: 'video-blob',
    currentId: 'one',
    sourceOptions: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }],
  });
  assert.match(script, /__codexWallpaperPushVideoChunk/);
  assert.match(script, /__codexWallpaperFinishVideo/);
  assert.match(script, /codexSkinCommand/);
  assert.match(script, /正在加载原视频/);
  assert.match(script, /视频加载进度/);
  assert.match(script, /codex-skin-progress-indeterminate/);
  assert.match(script, /aria-valuenow/);
  assert.match(script, /document\.hasFocus/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /已暂停（Codex 未激活）/);
  assert.match(script, /action: 'settings'/);
});

test('MCP apply exposes partial adjustments without instructing callers to reset defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-mcp-schema-'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/mcp-server.mjs', import.meta.url))], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, CODEX_SKIN_DATA_DIR: root, CODEX_SKIN_CDP_PORT: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  const apply = reply.result.tools.find(tool => tool.name === 'codex_skin_apply');
  assert.deepEqual(apply.inputSchema.required, ['id']);
  for (const property of Object.values(apply.inputSchema.properties)) {
    assert.equal(Object.hasOwn(property, 'default'), false);
  }
  assert.match(apply.description, /Omitted settings retain/);
});

test('allows only the exact Codex main-page CDP target', () => {
  assert.equal(isCodexTarget({ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://codex' }), true);
  assert.equal(isCodexTarget({ type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay', webSocketDebuggerUrl: 'ws://overlay' }), false);
  assert.equal(isCodexTarget({ type: 'webview', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://webview' }), false);
  assert.equal(isCodexTarget({ type: 'page', url: 'https://token.woa.com/', webSocketDebuggerUrl: 'ws://token' }), false);
});

test('discovers the exact Codex page on IPv4 or IPv6 loopback', async (t) => {
  for (const ipv4Available of [true, false]) {
    const calls = [];
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      if (!ipv4Available && url === 'http://127.0.0.1:9222/json') {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      }
      return {
        ok: true,
        json: async () => [
          { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://${new URL(url).host}/devtools/page/codex` },
          { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://unrelated' },
        ],
      };
    });
    try {
      const status = await CodexSkinBridge.prototype.debugStatus.call({ cdpPort: 9222 });
      assert.deepEqual(status, { available: true, port: 9222, targetCount: 1 });
      assert.deepEqual(calls, ipv4Available
        ? ['http://127.0.0.1:9222/json']
        : ['http://127.0.0.1:9222/json', 'http://[::1]:9222/json']);
    } finally {
      fetchMock.mock.restore();
    }
  }
});

test('automatically follows the published port without falling back to a fixed port', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-auto-port-'));
  const file = join(root, 'debug-endpoint.json');
  const probe = Object.assign(Object.create(CodexSkinBridge.prototype), {
    cdpPort: 0, debugEndpointFile: file, clients: new Map(),
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return { ok: true, json: async () => [] };
  });
  const unavailable = await probe.debugStatus();
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.port, null);
  assert.match(unavailable.error, /not published/);
  assert.deepEqual(calls, []);
  for (const port of [0, -1, 65536, '9222', null]) {
    writeFileSync(file, JSON.stringify({ port }), 'utf8');
    assert.equal((await probe.debugStatus()).available, false);
    await assert.rejects(probe.ensureClients(), /No valid debug port/);
    assert.deepEqual(calls, []);
  }
  writeFileSync(file, '{partial', 'utf8');
  assert.match((await probe.debugStatus()).error, /not published/);
  for (const port of [49152, 51234]) {
    writeFileSync(file, JSON.stringify({ port }), 'utf8');
    assert.deepEqual(await probe.debugStatus(), { available: false, port, targetCount: 0 });
    assert.deepEqual(await probe.ensureClients(), { targetCount: 0, added: [] });
    assert.deepEqual(calls.splice(0), [
      `http://127.0.0.1:${port}/json`, `http://127.0.0.1:${port}/json`,
    ]);
  }
  const fixed = Object.assign(Object.create(CodexSkinBridge.prototype), { cdpPort: 9223, debugEndpointFile: file });
  assert.equal((await fixed.debugStatus()).port, 9223);
  assert.deepEqual(calls, ['http://127.0.0.1:9223/json']);
});

test('connects to system-assigned loopback ports through the published record', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-live-auto-port-'));
  const file = join(root, 'debug-endpoint.json');
  const probe = Object.assign(Object.create(CodexSkinBridge.prototype), { cdpPort: 0, debugEndpointFile: file });
  const ports = [];
  for (let index = 0; index < 2; index++) {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([
        { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/codex` },
        { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://unrelated' },
      ]));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    ports.push(port);
    writeFileSync(file, JSON.stringify({ port }), 'utf8');
    assert.deepEqual(await probe.debugStatus(), { available: true, port, targetCount: 1 });
  }
  assert.notEqual(ports[0], ports[1]);
});

test('launcher confirms before restarting an already-running Codex instance', () => {
  const launcher = readFileSync(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../packaging/windows/setup.iss', import.meta.url), 'utf8');
  assert.match(launcher, /MessageBoxButton\]::YesNo/);
  assert.match(launcher, /Stop-Process -Id/);
  assert.match(launcher, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(launcher, /--site-per-process/);
  assert.match(launcher, /Scene initializer: \$sceneInitializer/);
  assert.ok(launcher.indexOf('$initialization = & $node.Source') < launcher.indexOf('Write-DebugEndpointRecord -ActualPort ([uri]$endpoint).Port'));
  assert.match(launcher, /\[int\]\$Port = 0/);
  assert.match(launcher, /if \(\$Port -ne 0\)/);
  assert.match(launcher, /-RedirectStandardError \$DebugLog -PassThru/);
  assert.match(launcher, /Write-DebugEndpointRecord -ActualPort \(\[uri\]\$endpoint\)\.Port/);
  assert.ok(launcher.indexOf('Write-DebugEndpointRecord -ActualPort 0') > launcher.indexOf('Stop-Process -Id'));
  assert.ok(launcher.indexOf('Assert-DebugPortAvailable -DebugPort $Port') < launcher.indexOf('Stop-Process -Id'));
  assert.ok(launcher.indexOf('$endpoint = Wait-CodexDebugEndpoint -DebugPort $Port') > launcher.indexOf('Start-CodexDesktop -Executable $executable'));
  assert.match(setup, /CloseApplications=no/);
  assert.match(setup, /RestartApplications=no/);
  assert.match(setup, /-WindowStyle Hidden/);
});

test('launcher validates isolated app discovery without WMI or restarting processes', {
  skip: process.platform !== 'win32',
}, () => {
  const launcher = fileURLToPath(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'skin-launch-validation-')));
  const app = join(root, 'app');
  mkdirSync(join(app, 'resources'), { recursive: true });
  const gui = join(app, 'ChatGPT.exe');
  const cli = join(app, 'resources', 'codex.exe');
  writeFileSync(gui, 'GUI fixture; never executed');
  writeFileSync(cli, 'CLI fixture; never executed');
  const quote = value => value.replaceAll("'", "''");
  const command = `
    function Get-CimInstance { throw 'WMI must not be used by the launcher.' }
    function Stop-Process { throw 'Validation must not stop processes.' }
    function Start-Process { throw 'Validation must not start processes.' }
    function Get-AppxPackage { [CmdletBinding()] param([string]$Name) return $null }
    $env:CODEX_CLI_PATH = '${quote(cli)}'
    & '${quote(launcher)}' -CodexHome '${quote(join(root, 'profile'))}' -DataDir '${quote(join(root, 'data'))}' -NodePath '${quote(process.execPath)}' -ValidateOnly
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${command}`, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(`Codex config home: ${join(root, 'profile')}`), result.stdout);
  assert.ok(result.stdout.includes(`Codex executable: ${gui}`), result.stdout);
  assert.match(result.stdout, /Codex processes: 0/);
  assert.match(result.stdout, /Codex requested debug port: 0 \(0 means automatic\)/);
  assert.match(result.stdout, /Launcher validation passed/);
});

test('launcher detects occupied ports and requires an exact ready Codex page', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const servers = [];
  for (const target of [
    { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/codex' },
    { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/other' },
  ]) {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([target]));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  const [codexPort, otherPort] = servers.map((server) => server.address().port);
  const root = mkdtempSync(join(tmpdir(), 'codex-launch-auto-port-'));
  const log = join(root, 'native.stderr.log');
  const recordFile = join(root, 'debug-endpoint.json');
  const launcher = fileURLToPath(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url));
  const command = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Net.Http
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}', [ref]$null, [ref]$null)
    $ast.FindAll({ param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -in @('Find-CodexDebugEndpoint', 'Assert-DebugPortAvailable', 'Wait-CodexDebugEndpoint', 'Read-LaunchedDebugPort', 'Write-DebugEndpointRecord')
    }, $false) | ForEach-Object { Invoke-Expression $_.Extent.Text }
    $blocked = $false
    try { Assert-DebugPortAvailable -DebugPort ${codexPort} }
    catch { $blocked = $_.Exception.Message -like '*cannot bind*' }
    if (-not $blocked) { throw 'Occupied port was accepted.' }
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    try { $probe.Start(); $freePort = $probe.LocalEndpoint.Port } finally { $probe.Stop() }
    Assert-DebugPortAvailable -DebugPort $freePort
    $expected = 'http://127.0.0.1:${codexPort}/json'
    if ((Find-CodexDebugEndpoint -DebugPort ${codexPort}) -ne $expected) { throw 'Codex endpoint was not found.' }
    if ((Wait-CodexDebugEndpoint -DebugPort ${codexPort} -TimeoutSeconds 0) -ne $expected) { throw 'Ready endpoint was rejected.' }
    if (Find-CodexDebugEndpoint -DebugPort ${otherPort}) { throw 'Unrelated page was accepted.' }
    if (-not $script:lastDebugFailure.Contains('http://127.0.0.1:${otherPort}/json') -or
        -not $script:lastDebugFailure.Contains('http://[::1]:${otherPort}/json')) {
      throw 'IPv4 readiness evidence was overwritten by the IPv6 error.'
    }
    if (-not $script:lastDebugFailure.Contains('https://example.com') -or
        $script:lastDebugFailure -notmatch 'System\.(Net\.Sockets\.SocketException|Threading\.Tasks\.TaskCanceledException)') {
      throw "Target URLs or nested transport errors were omitted: $script:lastDebugFailure"
    }
    $notReady = $false
    try { Wait-CodexDebugEndpoint -DebugPort ${otherPort} -TimeoutSeconds 0 }
    catch { $notReady = $_.Exception.Message -like '*not ready*' }
    if (-not $notReady) { throw 'Unavailable endpoint was reported ready.' }
    $env:CODEX_SKIN_DATA_DIR = '${root.replaceAll("'", "''")}'
    $log = '${log.replaceAll("'", "''")}'
    if (Read-LaunchedDebugPort -DebugLog $log) { throw 'Missing log was accepted.' }
    foreach ($line in @(
      'DevTools listening on ws://0.0.0.0:${codexPort}/devtools/browser/codex',
      'DevTools listening on ws://example.com:${codexPort}/devtools/browser/codex',
      'DevTools listening on ws://127.0.0.1:0/devtools/browser/codex',
      'DevTools listening on ws://127.0.0.1:65536/devtools/browser/codex',
      'Debugger listening on ws://127.0.0.1:${codexPort}/devtools/browser/codex'
    )) {
      [System.IO.File]::WriteAllText($log, $line)
      if (Read-LaunchedDebugPort -DebugLog $log) { throw 'Invalid endpoint output was accepted.' }
    }
    foreach ($hostName in @('127.0.0.1', '[::1]', 'localhost')) {
      [System.IO.File]::WriteAllText($log, "native startup output\`nDevTools listening on ws://\${hostName}:${codexPort}/devtools/browser/test-guid\`n")
      if ((Read-LaunchedDebugPort -DebugLog $log) -ne ${codexPort}) { throw 'Assigned port was not read.' }
    }
    $writer = [System.IO.File]::Open($log, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
      if (Read-LaunchedDebugPort -DebugLog $log) { throw 'Empty active log was accepted.' }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("DevTools listening on ws://127.0.0.1:${codexPort}/devtools/browser/active-writer\`n")
      $writer.Write($bytes, 0, $bytes.Length)
      $writer.Flush()
      if ((Read-LaunchedDebugPort -DebugLog $log) -ne ${codexPort}) { throw 'Port cannot be read while native output is still open.' }
      if ((Wait-CodexDebugEndpoint -DebugPort 0 -DebugLog $log -TimeoutSeconds 0) -ne $expected) { throw 'Active-log readiness failed.' }
      $writer.WriteByte(10)
      $writer.Flush()
    } finally { $writer.Dispose() }
    $actual = Wait-CodexDebugEndpoint -DebugPort 0 -DebugLog $log -TimeoutSeconds 0
    if ($actual -ne $expected) { throw 'Automatic readiness did not use the actual port.' }
    if ($script:lastDebugFailure) { throw 'Successful discovery kept stale failure evidence.' }
    Write-DebugEndpointRecord -ActualPort ([uri]$actual).Port -ProcessId $PID
    $record = Get-Content -LiteralPath '${recordFile.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
    if ($record.port -ne ${codexPort} -or $record.processId -ne $PID) { throw 'Assigned port was not published.' }
    Write-DebugEndpointRecord -ActualPort 0
    Write-Output 'PORT_AND_READINESS_CHECKS_PASSED'
  `;
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { windowsHide: true });
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
    assert.match(stdout, /PORT_AND_READINESS_CHECKS_PASSED/);
    const raw = readFileSync(recordFile);
    assert.notEqual(raw[0], 0xef, 'The shared record must not have a UTF-8 BOM.');
    assert.equal(JSON.parse(raw.toString('utf8')).port, 0);
  } finally {
    clearTimeout(timer);
  }
});

test('launcher waits for a late main page and stops waiting when its launched process exits', {
  skip: process.platform !== 'win32',
}, async (t) => {
  let readyAt = Infinity;
  let earlyRequests = 0;
  const server = createServer((_request, response) => {
    const ready = Date.now() >= readyAt;
    if (!ready) {
      earlyRequests++;
      if (readyAt === Infinity) readyAt = Date.now() + 25_000;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{
      type: 'page',
      url: ready ? 'app://-/index.html' : 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/late-main-page',
    }]));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const root = mkdtempSync(join(tmpdir(), 'codex-launch-late-page-'));
  const log = join(root, 'native.stderr.log');
  writeFileSync(log, `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fixture\n`);
  const launcher = fileURLToPath(new URL('../scripts/launch-codex-with-skin.ps1', import.meta.url));
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -AssemblyName System.Net.Http
    $ast = [Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}', [ref]$null, [ref]$null)
    $parameter = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'StartupTimeoutSeconds' }
    if (-not $parameter -or $parameter.DefaultValue.Value -ne 90) { throw 'The startup compatibility window is missing.' }
    $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) |
      ForEach-Object { Invoke-Expression $_.Extent.Text }
    $log = '${log.replaceAll("'", "''")}'
    $earlyFailed = $false
    try { Wait-CodexDebugEndpoint -DebugPort 0 -DebugLog $log -TimeoutSeconds 20 -ProcessId $PID }
    catch { $earlyFailed = $_.Exception.Message -like '*not ready*' }
    if (-not $earlyFailed) { throw 'The blank startup page was reported ready.' }
    $endpoint = Wait-CodexDebugEndpoint -DebugPort 0 -DebugLog $log -ProcessId $PID
    if ($endpoint -ne 'http://127.0.0.1:${port}/json') { throw 'The later main page was not detected.' }
    $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','exit 0'
    if (-not $process.WaitForExit(5000)) { throw 'The isolated process did not finish.' }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $exited = $false
    try { Wait-CodexDebugEndpoint -DebugPort 0 -DebugLog $log -TimeoutSeconds 90 -ProcessId $process.Id }
    catch { $exited = $_.Exception.Message -like '*exited before*' }
    if (-not $exited -or $watch.Elapsed.TotalSeconds -ge 2) { throw 'An exited process kept the launcher waiting.' }
    Write-Output 'LATE_MAIN_PAGE_AND_PROCESS_EXIT_PASSED'
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { windowsHide: true, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 40_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /LATE_MAIN_PAGE_AND_PROCESS_EXIT_PASSED/);
    assert.ok(earlyRequests >= 2);
    assert.equal(readFileSync(log, 'utf8'), `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fixture\n`);
  } finally {
    clearTimeout(timer);
  }
});

test('rejects paths outside the selected project directory', () => {
  const root = resolve('project-root');
  assert.equal(isPathInside(root, join(root, 'media', 'video.mp4')), true);
  assert.equal(isPathInside(root, resolve(root, '..', 'secret.txt')), false);
});

test('persists and clears the last enabled Codex skin safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-skin-state-'));
  const file = join(root, 'state.json');
  const state = { enabled: true, id: '3030258462', fitMode: 'cover', zoom: 100 };
  writeSavedSkinState(state, file);
  assert.deepEqual(readSavedSkinState(file), state);
  clearSavedSkinState(file);
  assert.equal(existsSync(file), false);
  assert.equal(readSavedSkinState(file), null);
});

test('disconnect keeps saved skin while explicit remove clears it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-skin-lifecycle-'));
  const file = join(root, 'state.json');
  const bridge = new CodexSkinBridge({ cdpPort: 1, stateFile: file, restoreIntervalMs: 60_000 });
  bridge.active = {
    currentId: '3030258462', panelOpacity: 0.68, scrimOpacity: 0.22,
    blurPx: 16, muted: true, fitMode: 'cover', zoom: 100,
    positionX: 50, positionY: 50, showControls: true,
  };
  bridge.persistActive();
  bridge.disconnect();
  assert.equal(readSavedSkinState(file)?.id, '3030258462');

  const remover = new CodexSkinBridge({ cdpPort: 1, stateFile: file, restoreIntervalMs: 60_000 });
  await remover.remove();
  remover.disconnect();
  assert.equal(readSavedSkinState(file), null);
});

test('falls back to an inline preview when a video exceeds the safe limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'we-inline-'));
  const video = join(root, 'large.mp4');
  const preview = join(root, 'preview.gif');
  writeFileSync(video, Buffer.alloc(1024 * 1024 + 1));
  writeFileSync(preview, 'GIF89a');
  const previous = process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB;
  const previousExtraction = process.env.CODEX_SKIN_DISABLE_FRAME_EXTRACTION;
  const previousBlob = process.env.CODEX_SKIN_DISABLE_BLOB_VIDEO;
  process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB = '1';
  process.env.CODEX_SKIN_DISABLE_FRAME_EXTRACTION = '1';
  process.env.CODEX_SKIN_DISABLE_BLOB_VIDEO = '1';
  try {
    const selected = selectEmbeddableMedia({ type: 'video', filePath: video, previewPath: preview });
    assert.equal(selected.mode, 'preview');
    assert.equal(selected.fallback, true);
    assert.match(selected.mediaUrl, /^data:image\/gif;base64,/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB;
    else process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB = previous;
    if (previousExtraction === undefined) delete process.env.CODEX_SKIN_DISABLE_FRAME_EXTRACTION;
    else process.env.CODEX_SKIN_DISABLE_FRAME_EXTRACTION = previousExtraction;
    if (previousBlob === undefined) delete process.env.CODEX_SKIN_DISABLE_BLOB_VIDEO;
    else process.env.CODEX_SKIN_DISABLE_BLOB_VIDEO = previousBlob;
  }
});

test('selects blob streaming for a video too large to inline', () => {
  const root = mkdtempSync(join(tmpdir(), 'we-blob-'));
  const video = join(root, 'video.mp4');
  const preview = join(root, 'preview.jpg');
  writeFileSync(video, Buffer.alloc(1024 * 1024 + 1));
  writeFileSync(preview, 'preview');
  const previous = process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB;
  process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB = '1';
  try {
    const selected = selectEmbeddableMedia({ type: 'video', filePath: video, previewPath: preview });
    assert.equal(selected.mode, 'video-blob');
    assert.equal(selected.videoPath, video);
    assert.equal(selected.videoBytes, 1024 * 1024 + 1);
  } finally {
    if (previous === undefined) delete process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB;
    else process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB = previous;
  }
});
