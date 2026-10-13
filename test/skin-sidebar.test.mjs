import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { SIDEBAR_ASSETS, installSkinSidebar } from '../src/skin-sidebar.mjs';
import { makeSidebarUpgradeScript } from '../src/codex-skin.mjs';

test('sidebar exports production assets and the exact nine rotation intervals', () => {
  assert.match(SIDEBAR_ASSETS.html, /id="tab-wallpapers"/);
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar-host/);
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar-host\{[^}]*border-radius:0!important[^}]*overflow:visible!important/);
  assert.match(SIDEBAR_ASSETS.css, /@media \(min-width:1600px\)\{[^}]*skin-sidebar-host[^}]*width:min\(460px,100vw\)!important/);
  assert.match(SIDEBAR_ASSETS.icons, /lucide/);
  assert.deepEqual([...SIDEBAR_ASSETS.html.matchAll(/option value="(\d+)"/g)].map(match => Number(match[1])).filter(value => value >= 5), [5, 30, 60, 300, 1800, 3600, 7200, 21600, 43200]);
});

test('installer serializes and uses only the trusted icon namespace', () => {
  const source = installSkinSidebar.toString();
  assert.doesNotMatch(source, /\beval\b|new Function|createElement\('script'\)/);
  assert.match(source, /window\.__codexWallpaperLucide/);
  assert.match(source, /createIcons\?\.\(\{ root, attrs:/);
  assert.match(source, /root\.querySelectorAll\('svg\[data-lucide\]'\)/);
  assert.doesNotMatch(source, /width: 'min\(440px, 100vw\)'/);
  assert.match(source, /statusNode\?\.textContent/);
  assert.match(source, /updateStatus/);
  assert.match(source, /pause\.dataset\.paused/);
  assert.match(source, /getCropPreview\?\.\(\)/);
  assert.match(source, /media\?\.videoWidth \|\| media\?\.naturalWidth/);
  assert.match(source, /action === 'refresh-library' && !isBusy\?\.\(\)/);
  assert.match(source, /const newlyOpened = show && !panelOpen/);
  assert.match(source, /if \(newlyOpened\) requestLibraryRefresh\(\)/);
  assert.match(source, /refreshLibrary/);
  const updateStatus = source.slice(source.indexOf('const updateStatus'), source.indexOf('const changeZoom'));
  assert.doesNotMatch(updateStatus, /renderLibrary|renderPlaylist|renderCrop/);
});

test('sidebar separates window controls and uses one decoded motion source', () => {
  assert.match(SIDEBAR_ASSETS.html, /<strong>Codex 动态壁纸<\/strong><small>Codex Live Wallpaper<\/small>/);
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar__header\{[^}]*padding:52px/);
  assert.doesNotMatch(SIDEBAR_ASSETS.css, /skin-sidebar__header\{[^}]*padding-top:10px/);
  assert.match(SIDEBAR_ASSETS.html, /data-fit="contain"/);
  assert.match(SIDEBAR_ASSETS.html, /data-fit="cover"/);
  assert.match(SIDEBAR_ASSETS.html, /canvas[^>]+data-crop-motion/);
  const source = installSkinSidebar.toString();
  assert.match(source, /motionMedia\.requestVideoFrameCallback/);
  assert.match(source, /motionContext\.drawImage\(media/);
  assert.doesNotMatch(source, /toDataURL|createElement\('video'\)/);
  const outside = source.slice(source.indexOf("listen(document, 'pointerdown'"), source.indexOf('const theme'));
  assert.match(outside, /controls\.contains\(event\.target\)/);
  assert.match(outside, /setOpen\(false\)/);
  assert.doesNotMatch(outside, /preventDefault|stopPropagation|focus/);
});

test('sidebar ownership transfers only to a registered matching upgraded controller', () => {
  for (const [requested, registered, expected] of [
    ['next', ['old', 'next'], 'next'],
    [null, ['old', 'next'], 'old'],
    ['stranger', ['old', 'next'], 'old'],
    ['next', ['old'], 'old'],
  ]) {
    const runtime = { config: { controllerId: 'next' }, controllers: registered,
      sidebarOwner: 'old', sidebar: { version: 7, refresh() {} } };
    const host = { __codexWallpaperRuntime: runtime, __codexWallpaperSidebarOwner: 'old',
      __codexWallpaperLucide: {} };
    const controls = { sidebarVersion: 7 };
    const result = runInNewContext(makeSidebarUpgradeScript(requested), {
      window: host,
      document: { createElement: () => ({ content: {} }), getElementById: () => controls, body: {} },
      MutationObserver: class { observe() {} disconnect() {} },
    });
    assert.equal(result.upgraded, true);
    assert.equal(runtime.sidebarOwner, expected);
    assert.equal(host.__codexWallpaperSidebarOwner, expected);
    assert.equal(host.__codexWallpaperRuntime, runtime);
  }
});

test('author controls live only in Settings and hide entirely without author parameters', () => {
  const wallpaperPage = SIDEBAR_ASSETS.html.slice(
    SIDEBAR_ASSETS.html.indexOf('data-page="wallpapers"'), SIDEBAR_ASSETS.html.indexOf('data-page="appearance"'));
  assert.doesNotMatch(wallpaperPage, /data-slot="author-controls"|data-author-section/);
  const settingsPage = SIDEBAR_ASSETS.html.slice(SIDEBAR_ASSETS.html.indexOf('data-page="advanced"'));
  assert.match(settingsPage, /壁纸设置/);
  assert.match(settingsPage, /data-slot="author-controls"/);
  assert.match(settingsPage, /data-author-section hidden/);
  assert.doesNotMatch(SIDEBAR_ASSETS.html, /data-author-empty|这张壁纸没有可调整/);
  assert.match(installSkinSidebar.toString(), /one\('\[data-author-section\]'\)\.hidden = authorControls\.length === 0/);
  assert.equal([...SIDEBAR_ASSETS.html.matchAll(/data-slot="author-controls"/g)].length, 1);
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar__author-row/);
});

test('search focus belongs to its outer wrapper, without an inner input outline or shadow', () => {
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar__search:focus-within\{border-color:var\(--accent\)\}/);
  assert.match(SIDEBAR_ASSETS.css, /skin-sidebar \.skin-sidebar__search input\{[^}]*outline:none!important;box-shadow:none!important/);
});

test('Scene failures have actionable explanations and copyable AI diagnostics without changing playback', () => {
  assert.match(SIDEBAR_ASSETS.html, /data-scene-failure role="status" hidden/);
  assert.match(SIDEBAR_ASSETS.html, /data-diagnostic-text[^>]*readonly hidden/);
  assert.match(SIDEBAR_ASSETS.html, /data-action="copy-diagnostics"/);
  const source = installSkinSidebar.toString();
  assert.match(source, /getPlaybackState\?\.\(\)/);
  assert.match(source, /内存或虚拟内存不足/);
  assert.match(source, /图形上下文已丢失/);
  assert.match(source, /navigator\.clipboard\.writeText\(prompt\)/);
  const copy = source.slice(source.indexOf('const copyDiagnostics'), source.indexOf('const setDisabled'));
  assert.match(copy, /input\.select\(\)/);
  assert.doesNotMatch(copy, /requestSelection|persistSettings|onSetting|onCrop|codexSkinCommand/);
});
