import { readFileSync } from 'node:fs';

export const SIDEBAR_ASSETS = {
  html: readFileSync(new URL('./assets/skin-sidebar.html', import.meta.url), 'utf8'),
  css: readFileSync(new URL('./assets/skin-sidebar.css', import.meta.url), 'utf8'),
  icons: readFileSync(new URL('./assets/lucide.min.js', import.meta.url), 'utf8'),
};

// Serialized into the trusted CDP injection. Do not capture module state here.
export function installSkinSidebar({ cfg, controls, toggle, panel, assets, statusNode, progressNode, diagnosticsNode,
  authorControls = [], getMedia, getCropPreview, getCropPreviewError, getPlaybackState, onRefreshPreview, onSetting, onCrop, onPause, requestSelection, persistSettings,
  onRotationChange, isBusy }) {
  const cleanups = [];
  let libraryCleanups = [];
  let playlistCleanups = [];
  const listen = (node, name, fn, options) => {
    node?.addEventListener?.(name, fn, options);
    cleanups.push(() => node?.removeEventListener?.(name, fn, options));
  };
  const clear = list => { list.splice(0).reverse().forEach(fn => fn()); };
  const listenRender = (list, node, name, fn, options) => {
    node.addEventListener(name, fn, options);
    list.push(() => node.removeEventListener(name, fn, options));
  };
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const uiKey = 'codex-wallpaper-sidebar-ui-v1';
  const defaults = { material: 'mist', theme: 'system', font: 'system', mascot: true, tab: 'wallpapers' };
  const saved = safe(() => JSON.parse(window.localStorage.getItem(uiKey) || 'null'), null);
  const ui = { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!['mist', 'clear'].includes(ui.material)) ui.material = 'mist';
  if (!['light', 'dark', 'system'].includes(ui.theme)) ui.theme = 'system';
  if (!['system', 'yahei', 'song'].includes(ui.font)) ui.font = 'system';
  if (!['wallpapers', 'appearance', 'playback', 'advanced'].includes(ui.tab)) ui.tab = 'wallpapers';
  ui.mascot = ui.mascot !== false;
  const saveUi = () => safe(() => window.localStorage.setItem(uiKey, JSON.stringify(ui)));
  const original = {
    children: [...panel.childNodes],
    className: panel.className,
    style: panel.getAttribute('style'),
    hidden: toggle?.hidden,
  };
  const moved = [statusNode, progressNode, diagnosticsNode, ...authorControls]
    .filter(Boolean).map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
  const styleId = (controls.id || 'codex-wallpaper-engine-skin-controls') + '-skin-sidebar-style';
  const replacedStyle = document.getElementById(styleId);
  const replacedStyleParent = replacedStyle?.parentNode || null;
  const replacedStyleNext = replacedStyle?.nextSibling || null;
  replacedStyle?.remove();
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = assets?.css || '';
  document.head.appendChild(style);
  panel.classList.add('skin-sidebar-host');
  for (const pair of Object.entries({
    position: 'fixed', top: '0', right: '0', bottom: '0', left: 'auto', height: '100dvh', maxHeight: '100dvh',
    margin: '0', padding: '0', pointerEvents: 'auto',
  })) panel.style.setProperty(pair[0], pair[1], 'important');
  panel.replaceChildren();
  const frame = document.createElement('template');
  frame.innerHTML = assets?.html || '';
  panel.append(...frame.content.childNodes);
  controls.sidebarVersion = 7;
  const root = panel.querySelector('.skin-sidebar');
  const one = selector => root.querySelector(selector);
  const many = selector => [...root.querySelectorAll(selector)];
  const icon = name => {
    const value = document.createElement('i');
    value.setAttribute('data-lucide', name);
    return value;
  };
  const current = () => (cfg.sourceOptions || []).find(source => source.id === cfg.currentId) || null;
  const category = source => {
    if (source?.category === 'static' || source?.type === 'static') return 'static';
    if (source?.category === 'video' || source?.type === 'video') return 'video';
    return 'scene';
  };
  const kind = source => ({ scene: '场景', video: '视频', static: '静态' })[category(source)];
  const playable = source => Boolean(source && source.skinMode !== 'preview' && ['scene', 'video'].includes(source.type));
  const renderIcons = () => safe(() => {
    window.__codexWallpaperLucide?.createIcons?.({ root, attrs: { 'stroke-width': 1.6 } });
    for (const node of root.querySelectorAll('svg[data-lucide]')) node.removeAttribute('data-lucide');
  });
  const statusLabel = one('[data-ui-status]');
  const cropPreview = one('[data-crop-preview]');
  const cropPlane = one('[data-crop-plane]');
  const cropImage = one('[data-crop-image]');
  const cropMotion = one('[data-crop-motion]');
  const cropFrame = one('[data-crop-frame]');
  const cropLoading = one('[data-crop-loading]');
  const cropStatus = one('[data-crop-status]');
  const search = one('[data-library-search]');
  const library = one('[data-library]');
  const empty = one('[data-library-empty]');
  const thumbnailRequests = new Map();
  const thumbnailCache = new Map();
  let thumbnailCacheBytes = 0;
  const thumbnailFailures = new Map();
  const thumbnailImages = (id, url) => [...root.querySelectorAll('img[data-thumbnail-id]')]
    .filter(image => image.dataset.thumbnailId === String(id) && image.dataset.thumbnailUrl === url);
  cleanups.push(() => {
    for (const request of thumbnailRequests.values()) window.clearTimeout(request.timer);
    thumbnailRequests.clear();
  });
  let refreshError = null;
  const renderLibraryNotice = () => {
    const notice = one('[data-library-status]');
    const failure = thumbnailFailures.values().next().value;
    notice.textContent = refreshError || (failure ? '预览加载失败：' + failure : '');
    notice.hidden = !notice.textContent;
  };
  const resolveThumbnail = result => {
    const request = thumbnailRequests.get(result?.requestId);
    if (!request || request.id !== result.id || request.url !== result.url) return;
    request.finish();
    if (!root.isConnected
        || !(cfg.sourceOptions || []).some(item => item.id === result.id && item.thumbnailUrl === result.url)) return;
    if (typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/')) {
      request.fail(String(result.error || '壁纸服务未返回预览图片'));
      return;
    }
    const bytes = result.dataUrl.length;
    if (bytes <= 8 * 1024 * 1024) {
      while (thumbnailCacheBytes + bytes > 8 * 1024 * 1024 && thumbnailCache.size) {
        const [url, value] = thumbnailCache.entries().next().value;
        thumbnailCache.delete(url);
        thumbnailCacheBytes -= value.length;
      }
      const previous = thumbnailCache.get(result.url);
      if (previous) thumbnailCacheBytes -= previous.length;
      thumbnailCache.set(result.url, result.dataUrl);
      thumbnailCacheBytes += bytes;
    }
    for (const image of thumbnailImages(result.id, result.url)) {
      image.dataset.previewState = 'local';
      image.loading = 'eager';
      image.src = result.dataUrl;
    }
  };
  const loadThumbnail = (image, source, disposers) => {
    if (!source?.thumbnailUrl) { image.alt = '无预览'; return; }
    image.dataset.thumbnailId = String(source.id);
    image.dataset.thumbnailUrl = source.thumbnailUrl;
    let requestId = null;
    let local = thumbnailCache.has(source.thumbnailUrl);
    const finish = () => {
      if (!requestId) return;
      const request = thumbnailRequests.get(requestId);
      if (request) window.clearTimeout(request.timer);
      thumbnailRequests.delete(requestId);
      requestId = null;
    };
    const fail = message => {
      finish();
      if (!root.isConnected || !(cfg.sourceOptions || []).some(item => item.id === source.id
          && item.thumbnailUrl === source.thumbnailUrl)) return;
      const reason = String(message).slice(0, 300);
      for (const target of thumbnailImages(source.id, source.thumbnailUrl)) {
        target.dataset.previewState = 'failed';
        target.alt = '预览加载失败';
        target.title = reason;
      }
      thumbnailFailures.set(source.id, reason);
      renderLibraryNotice();
    };
    listenRender(disposers, image, 'load', () => {
      image.dataset.previewState = 'ready';
      thumbnailFailures.delete(source.id);
      renderLibraryNotice();
    });
    listenRender(disposers, image, 'error', () => {
      if (local || image.src.startsWith('data:image/')) { fail('本地预览图片无法解码'); return; }
      local = true;
      if (thumbnailCache.has(source.thumbnailUrl)) {
        image.src = thumbnailCache.get(source.thumbnailUrl);
        return;
      }
      if ([...thumbnailRequests.values()].some(request => request.id === source.id && request.url === source.thumbnailUrl)) {
        image.dataset.previewState = 'loading-local';
        return;
      }
      if (typeof window.codexSkinCommand !== 'function') { fail('壁纸服务未连接，请重新打开壁纸启动器'); return; }
      requestId = String(cfg.instanceId || 'skin') + ':thumbnail:'
        + (window.__codexWallpaperThumbnailSequence = (window.__codexWallpaperThumbnailSequence || 0) + 1);
      const request = { image, id: source.id, url: source.thumbnailUrl, finish, fail,
        timer: window.setTimeout(() => fail('壁纸服务未响应，请重新打开壁纸启动器'), 10000) };
      thumbnailRequests.set(requestId, request);
      image.dataset.previewState = 'loading-local';
      try {
        const sent = window.codexSkinCommand(JSON.stringify({
          action: 'preview-thumbnail', controllerId: cfg.controllerId, instanceId: cfg.instanceId,
          requestId, id: source.id, url: source.thumbnailUrl,
        }));
        sent?.catch?.(error => fail(error?.message || '本地预览读取失败'));
      } catch (error) {
        fail(error?.message || '本地预览读取失败');
      }
    });
    if (local) image.loading = 'eager';
    image.src = thumbnailCache.get(source.thumbnailUrl) || source.thumbnailUrl;
  };
  let filter = 'all';
  let crop = null;
  let dragging = null;
  let settingsOpen = false;
  let beforeSettings = ui.tab;
  let motionMedia = null;
  let motionCallback = null;
  let motionAnimation = null;
  let previewInView = true;
  let panelOpen = false;
  const motionContext = cropMotion.getContext('2d');
  const stopMotion = () => {
    if (motionCallback !== null) motionMedia?.cancelVideoFrameCallback?.(motionCallback);
    if (motionAnimation !== null) cancelAnimationFrame(motionAnimation);
    motionCallback = null;
    motionAnimation = null;
  };
  const motionVisible = () => root.isConnected
    && panel.style.display !== 'none' && !settingsOpen && ui.tab === 'wallpapers'
    && !cropMotion.hidden && cropPlane.style.display !== 'none';
  const drawMotion = () => {
    if (!motionContext || !motionVisible() || !crop?.live) return;
    const media = safe(() => getMedia?.(), null);
    if (!media || (media.tagName === 'VIDEO' && media.readyState < 2)) return;
    const scale = Math.min(1, 960 / crop.width, 540 / crop.height);
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    if (cropMotion.width !== width) cropMotion.width = width;
    if (cropMotion.height !== height) cropMotion.height = height;
    try {
      motionContext.drawImage(media, 0, 0, width, height);
      cropLoading.hidden = true;
    } catch {
      cropLoading.textContent = '暂时无法预览';
      cropLoading.hidden = false;
    }
  };
  const queueMotion = () => {
    if (document.hidden || !previewInView || !motionVisible() || !motionMedia || cfg.userPaused
        || (motionMedia.tagName === 'VIDEO' && motionMedia.paused)) return;
    if (motionCallback !== null || motionAnimation !== null) return;
    // Share decoded frames with the background; no second video or JPEG polling.
    if (motionMedia.tagName === 'VIDEO' && motionMedia.requestVideoFrameCallback) {
      motionCallback = motionMedia.requestVideoFrameCallback(() => {
        motionCallback = null;
        drawMotion();
        queueMotion();
      });
    } else {
      motionAnimation = requestAnimationFrame(() => {
        motionAnimation = null;
        drawMotion();
        queueMotion();
      });
    }
  };
  const syncMotion = () => {
    stopMotion();
    motionMedia = safe(() => getMedia?.(), null);
    drawMotion();
    queueMotion();
  };
  cleanups.push(stopMotion);
  const move = (node, slot) => { if (node && slot) slot.appendChild(node); };
  move(statusNode, one('[data-slot="status"]'));
  move(progressNode, one('[data-slot="progress"]'));
  move(diagnosticsNode, one('[data-slot="diagnostics"]'));
  for (const node of authorControls) move(node, one('[data-slot="author-controls"]'));
  one('[data-author-section]').hidden = authorControls.length === 0;
  for (const row of authorControls) {
    row.classList.add('skin-sidebar__author-row');
    const input = row.querySelector('[data-user-property]');
    row.dataset.type = input?.type || input?.tagName?.toLowerCase();
    if (input?.type === 'checkbox') input.setAttribute('role', 'switch');
    if (input?.dataset.userProperty === 'schemecolor'
        && row.firstElementChild?.textContent === 'ui_browse_properties_scheme_color') {
      row.firstElementChild.textContent = '配色';
      row.firstElementChild.title = '配色';
      input.setAttribute('aria-label', '配色');
    }
  }
  const applyUi = () => {
    root.dataset.material = ui.material;
    root.dataset.theme = ui.theme === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : ui.theme;
    root.style.setProperty('--font', {
      system: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif',
      yahei: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
      song: '"SimSun", "Songti SC", serif',
    }[ui.font]);
    if (toggle) toggle.hidden = !ui.mascot;
    for (const button of many('[data-material]')) button.setAttribute('aria-pressed', String(button.dataset.material === ui.material));
    one('[data-ui-setting="theme"]').value = ui.theme;
    one('[data-ui-setting="font"]').value = ui.font;
    one('[data-ui-setting="mascot"]').checked = ui.mascot;
  };
  const requestLibraryRefresh = () => {
    refreshError = null;
    renderLibraryNotice();
    try {
      if (typeof window.codexSkinCommand !== 'function') throw new Error('壁纸服务未连接');
      const result = window.codexSkinCommand(JSON.stringify({ action: 'refresh-sources', controllerId: cfg.controllerId }));
      result?.catch?.(() => { refreshError = '壁纸列表更新失败，请点击刷新'; renderLibraryNotice(); });
    } catch {
      refreshError = '壁纸服务未连接，请重新打开壁纸启动器';
      renderLibraryNotice();
    }
  };
  const syncOpen = show => {
    const newlyOpened = show && !panelOpen;
    panelOpen = show;
    root.dataset.open = String(show);
    window.__codexWallpaperControlsOpen = show;
    toggle?.setAttribute('aria-expanded', String(show));
    if (show) renderCrop(); else stopMotion();
    if (newlyOpened) requestLibraryRefresh();
  };
  const setOpen = open => {
    const show = Boolean(open);
    panel.style.display = show ? 'block' : 'none';
    syncOpen(show);
  };
  const setTab = value => {
    ui.tab = ['wallpapers', 'appearance', 'playback', 'advanced'].includes(value) ? value : 'wallpapers';
    root.dataset.view = ui.tab;
    for (const tab of many('[role="tab"]')) {
      const selected = tab.dataset.tab === ui.tab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const page of many('[data-page]')) page.hidden = page.dataset.page !== ui.tab || settingsOpen;
    saveUi();
    syncMotion();
  };
  const setSettings = value => {
    settingsOpen = Boolean(value);
    one('[data-wallpaper-heading]').hidden = settingsOpen;
    one('.skin-sidebar__settings-heading').hidden = !settingsOpen;
    one('[data-action="open-settings"]').setAttribute('aria-expanded', String(settingsOpen));
    one('.skin-sidebar__tabs').hidden = settingsOpen;
    one('.skin-sidebar__general').hidden = !settingsOpen;
    for (const page of many('[data-page]')) page.hidden = settingsOpen || page.dataset.page !== ui.tab;
    syncMotion();
  };
  let diagnosticPrompt = '';
  const renderStatus = () => {
    const text = statusNode?.textContent?.trim();
    const source = current();
    const state = safe(() => getPlaybackState?.(), null);
    const error = state?.sceneError || '';
    const failure = one('[data-scene-failure]');
    failure.hidden = !error;
    statusLabel.dataset.failed = String(Boolean(error));
    const next = error ? '场景加载失败' : text || (source?.skinMode === 'preview' ? '预览模式' : source ? '已就绪' : '选择壁纸');
    if (statusLabel.textContent !== next) statusLabel.textContent = next;
    const prompt = error ? [
      '请帮助排查 Codex 动态壁纸（Codex Live Wallpaper）的 Scene 加载失败。',
      '请先查明原因，再给出修复方法；不要只隐藏错误或反复自动重试。',
      '壁纸：' + (source?.title || '未知'),
      '项目 ID：' + (cfg.currentId || '未知'),
      '当前显示：' + (state.mode === 'preview' ? '预览图，非实际场景' : state.mode || '未知'),
      '原始错误：' + error,
    ].join('\n') : '';
    if (diagnosticPrompt === prompt) return;
    diagnosticPrompt = prompt;
    one('[data-copy-label]').textContent = '复制诊断';
    one('[data-copy-feedback]').textContent = '';
    one('[data-diagnostic-text]').hidden = true;
    one('[data-diagnostic-text]').value = prompt;
    if (!error) return;
    const preview = state.mode === 'preview' ? '，已显示预览图' : '';
    const memory = /array buffer allocation failed|out of memory|memory allocation failed/i.test(error);
    const graphics = /webgl.*context.*lost|context lost/i.test(error);
    one('[data-failure-heading]').textContent = (memory ? '场景内存分配失败' : graphics ? '图形渲染中断' : '场景加载失败') + preview;
    one('[data-failure-message]').textContent = memory
      ? '场景申请内存失败，可能是内存或虚拟内存不足。请先退出占用内存较大的程序，再重新选择壁纸。'
      : graphics ? '图形上下文已丢失，可能与显存压力、驱动或设备状态有关。请先降低其他程序的图形负载，再重新选择壁纸。'
        : '场景未能正常加载。请检查本地壁纸资源和壁纸服务；错误详情可用于进一步排查。';
    one('[data-failure-error]').textContent = error;
  };
  const copyDiagnostics = async () => {
    const prompt = diagnosticPrompt;
    if (!prompt) return;
    const button = one('[data-action="copy-diagnostics"]');
    button.disabled = true;
    one('[data-copy-label]').textContent = '复制诊断';
    one('[data-copy-feedback]').textContent = '';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      if (root.isConnected && diagnosticPrompt === prompt) {
        one('[data-copy-label]').textContent = '已复制';
        one('[data-diagnostic-text]').hidden = true;
      }
    } catch {
      if (root.isConnected && diagnosticPrompt === prompt) {
        const input = one('[data-diagnostic-text]');
        input.hidden = false;
        input.focus();
        input.select();
        one('[data-copy-feedback]').textContent = '无法自动复制，请复制下方已选中的诊断信息。';
      }
    } finally {
      button.disabled = false;
    }
  };
  const setDisabled = (selector, disabled) => {
    for (const node of many(selector)) node.disabled = disabled;
  };
  const renderDetails = () => {
    const source = current();
    one('[data-current-title]').textContent = source?.title || '未选择壁纸';
    one('[data-current-id]').textContent = source?.id || '';
    const currentKind = one('[data-current-kind]');
    const kindKey = category(source);
    if (currentKind.dataset.kind !== kindKey) {
      currentKind.replaceChildren(icon(kindKey === 'video' ? 'film' : kindKey === 'scene' ? 'layers' : 'image'), document.createTextNode(kind(source)));
      currentKind.dataset.kind = kindKey;
    }
    one('[data-detail-id]').textContent = source?.id || '未选择';
    one('[data-detail-kind]').textContent = source ? kind(source) : '未选择';
    const preview = safe(() => getCropPreview?.(), null);
    const media = safe(() => getMedia?.(), null);
    const dimensions = [
      [preview?.width, preview?.height],
      [media?.videoWidth || media?.naturalWidth || (media?.tagName === 'CANVAS' ? media.width : 0), media?.videoHeight || media?.naturalHeight || (media?.tagName === 'CANVAS' ? media.height : 0)],
      [source?.sourceWidth, source?.sourceHeight],
    ].find(pair => Number.isFinite(Number(pair[0])) && Number(pair[0]) > 0 && Number.isFinite(Number(pair[1])) && Number(pair[1]) > 0);
    one('[data-detail-dimensions]').textContent = dimensions
      ? String(dimensions[0]) + ' x ' + String(dimensions[1]) : '等待媒体';
    const pause = one('[data-action="pause"]');
    const paused = cfg.userPaused === true;
    if (pause.dataset.paused !== String(paused)) {
      pause.replaceChildren(icon(paused ? 'play' : 'pause'));
      pause.title = paused ? '继续预览' : '暂停预览';
      pause.setAttribute('aria-label', pause.title);
      pause.setAttribute('aria-pressed', String(paused));
      pause.dataset.paused = String(paused);
    }
    const unavailable = !source || cfg.mode === 'picker' || !playable(source) || Boolean(isBusy?.());
    pause.disabled = unavailable;
    one('[data-action="refresh-library"]').disabled = Boolean(isBusy?.());
    setDisabled('[data-page="playback"] [data-setting], [data-page="playback"] [data-field] input', !source || cfg.mode === 'picker' || !playable(source));
    setDisabled('[data-setting="mouseEnabled"]', !source || cfg.mode === 'picker' || source.type !== 'scene');
  };
  const renderRanges = () => {
    for (const input of many('[data-setting]')) input.checked = cfg[input.dataset.setting] === true;
    for (const field of many('[data-field]')) {
      const input = field.querySelector('input[type="range"]');
      const valueInput = field.querySelector('input[type="number"]');
      const name = field.dataset.field;
      const value = name === 'volume' ? clamp(cfg.volume, 0, 1, .3) * 100
        : name === 'panelOpacity' || name === 'scrimOpacity' ? clamp(cfg[name], 0, 1, 0) * 100
          : clamp(cfg[name], 0, 40, 0);
      input.value = String(Math.round(value));
      if (valueInput) valueInput.value = String(Math.round(value));
    }
  };
  const renderCrop = () => {
    for (const button of many('[data-fit]')) {
      button.setAttribute('aria-pressed', String(button.dataset.fit === cfg.fitMode));
      button.disabled = !current() || cfg.mode === 'picker' || Boolean(isBusy?.());
    }
    crop = safe(() => getCropPreview?.(), null);
    if (!crop || (!crop.url && !crop.live) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
      stopMotion();
      cropPlane.style.display = 'none';
      cropLoading.hidden = false;
      const error = getCropPreviewError?.();
      cropLoading.textContent = error ? '预览截图失败，可点击刷新重新获取' : '等待原始媒体尺寸';
      cropLoading.title = error || '';
      cropStatus.textContent = error ? '预览不可用' : '等待媒体';
      setDisabled('[data-action^="crop-"]', true);
      return;
    }
    const extent = crop.extent && typeof crop.extent === 'object' ? crop.extent : { x: 0, y: 0, width: 1, height: 1 };
    const map = {
      x: Number.isFinite(extent.x) ? extent.x : 0, y: Number.isFinite(extent.y) ? extent.y : 0,
      width: Math.max(.0001, Number.isFinite(extent.width) ? extent.width : 1),
      height: Math.max(.0001, Number.isFinite(extent.height) ? extent.height : 1),
    };
    const area = crop.crop && typeof crop.crop === 'object' ? crop.crop : { x: 0, y: 0, width: 1, height: 1 };
    cropPreview.style.aspectRatio = String(crop.width * map.width) + ' / ' + String(crop.height * map.height);
    const rect = cropPreview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / (crop.width * map.width), rect.height / (crop.height * map.height));
    const imageWidth = crop.width * scale;
    const imageHeight = crop.height * scale;
    Object.assign(cropPlane.style, {
      display: 'block', width: String(imageWidth * map.width) + 'px', height: String(imageHeight * map.height) + 'px',
      left: String((rect.width - imageWidth * map.width) / 2) + 'px', top: String((rect.height - imageHeight * map.height) / 2) + 'px',
    });
    for (const node of [cropImage, cropMotion]) Object.assign(node.style, {
      width: String(imageWidth) + 'px', height: String(imageHeight) + 'px',
      left: String(-map.x * imageWidth) + 'px', top: String(-map.y * imageHeight) + 'px',
    });
    cropImage.hidden = Boolean(crop.live);
    cropMotion.hidden = !crop.live;
    if (!crop.live && cropImage.src !== crop.url) cropImage.src = crop.url;
    Object.assign(cropFrame.style, {
      left: String((area.x - map.x) / map.width * 100) + '%', top: String((area.y - map.y) / map.height * 100) + '%',
      width: String(area.width / map.width * 100) + '%', height: String(area.height / map.height * 100) + '%',
    });
    cropLoading.hidden = true;
    const full = area.width >= 1 - 1e-6 && area.height >= 1 - 1e-6;
    cropStatus.textContent = full ? '全部' : String(Math.round(area.width * 100)) + '% x ' + String(Math.round(area.height * 100)) + '%';
    const disabled = !current() || cfg.mode === 'picker' || Boolean(isBusy?.());
    one('[data-action="crop-shrink"]').disabled = disabled || Number(cfg.zoom) >= 400;
    one('[data-action="crop-expand"]').disabled = disabled || Number(cfg.zoom) <= 100;
    one('[data-action="crop-reset"]').disabled = disabled || (full && Number(cfg.zoom) <= 100);
    syncMotion();
  };
  const sendCrop = value => onCrop?.({
    fitMode: value.fitMode || cfg.fitMode || 'contain',
    zoom: clamp(value.zoom, 100, 400, clamp(cfg.zoom, 100, 400, 100)),
    positionX: clamp(value.positionX, 0, 100, clamp(cfg.positionX, 0, 100, 50)),
    positionY: clamp(value.positionY, 0, 100, clamp(cfg.positionY, 0, 100, 50)),
  });
  const renderPlaylist = () => {
    clear(playlistCleanups);
    const list = one('[data-playlist]');
    list.replaceChildren();
    const rotation = cfg.rotation || (cfg.rotation = { enabled: false, ids: [], intervalSeconds: 300, transition: 'fade', durationMs: 500 });
    if (!Array.isArray(rotation.ids)) rotation.ids = [];
    for (const pair of rotation.ids.entries()) {
      const index = pair[0];
      const id = pair[1];
      const source = (cfg.sourceOptions || []).find(item => item.id === id);
      const row = document.createElement('div');
      row.className = 'skin-sidebar__playlist-row';
      row.dataset.current = String(id === cfg.currentId);
      const image = document.createElement('img');
      image.alt = '';
      loadThumbnail(image, source, playlistCleanups);
      const title = document.createElement('span');
      title.textContent = source?.title || id;
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'skin-sidebar__icon-button'; up.title = '上移'; up.setAttribute('aria-label', '上移'); up.disabled = index === 0; up.appendChild(icon('chevron-up'));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'skin-sidebar__icon-button'; remove.title = '移出轮播'; remove.setAttribute('aria-label', '移出轮播'); remove.appendChild(icon('x'));
      listenRender(playlistCleanups, up, 'click', () => { [rotation.ids[index - 1], rotation.ids[index]] = [rotation.ids[index], rotation.ids[index - 1]]; onRotationChange?.(); persistSettings?.(); refresh(); });
      listenRender(playlistCleanups, remove, 'click', () => { rotation.ids = rotation.ids.filter(value => value !== id); if (rotation.ids.length < 2) rotation.enabled = false; onRotationChange?.(); persistSettings?.(); refresh(); });
      row.append(image, title, up, remove);
      list.appendChild(row);
    }
    const position = rotation.ids.indexOf(cfg.currentId);
    one('[data-playlist-position]').textContent = rotation.ids.length ? String(Math.max(0, position) + 1) + ' / ' + String(rotation.ids.length) : '未加入轮播';
    one('[data-action="add-current"]').disabled = !current() || rotation.ids.includes(cfg.currentId);
    one('[data-action="previous"]').disabled = rotation.ids.length < 2 || Boolean(isBusy?.());
    one('[data-action="next"]').disabled = rotation.ids.length < 2 || Boolean(isBusy?.());
    one('[data-rotation="enabled"]').checked = rotation.enabled === true;
    one('[data-rotation="enabled"]').disabled = rotation.ids.length < 2;
    const allowed = [5, 30, 60, 300, 1800, 3600, 7200, 21600, 43200];
    one('[data-rotation="intervalSeconds"]').value = String(allowed.includes(Number(rotation.intervalSeconds)) ? rotation.intervalSeconds : 300);
    one('[data-rotation="transition"]').value = rotation.transition === 'none' ? 'none' : 'fade';
  };
  const renderLibrary = () => {
    clear(libraryCleanups);
    library.replaceChildren();
    for (const button of many('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    const query = search.value.trim().toLocaleLowerCase();
    const sources = (cfg.sourceOptions || []).filter(source => (!query || (String(source.title || '') + ' ' + String(source.id || '')).toLocaleLowerCase().includes(query)) && (filter === 'all' || category(source) === filter));
    const visibleIds = new Set(sources.map(source => source.id));
    for (const id of thumbnailFailures.keys()) if (!visibleIds.has(id)) thumbnailFailures.delete(id);
    renderLibraryNotice();
    one('[data-library-count]').textContent = String(sources.length) + ' 张';
    one('[data-footer-count]').textContent = String((cfg.sourceOptions || []).length) + ' 张本地壁纸';
    empty.hidden = sources.length !== 0;
    for (const source of sources) {
      const tile = document.createElement('article');
      tile.className = 'skin-sidebar__tile wallpaper-tile';
      tile.dataset.current = String(source.id === cfg.currentId);
      const choose = document.createElement('button');
      choose.type = 'button'; choose.className = 'skin-sidebar__tile-select'; choose.disabled = Boolean(isBusy?.()) || source.id === cfg.currentId;
      choose.setAttribute('aria-label', '应用 ' + String(source.title || source.id));
      const wrap = document.createElement('span');
      wrap.className = 'skin-sidebar__tile-image';
      const image = document.createElement('img');
      image.alt = ''; image.loading = 'lazy';
      loadThumbnail(image, source, libraryCleanups);
      wrap.appendChild(image);
      const title = document.createElement('span');
      title.className = 'skin-sidebar__tile-title'; title.textContent = source.title || source.id; title.title = title.textContent;
      const type = document.createElement('span');
      type.className = 'skin-sidebar__tile-kind'; type.textContent = kind(source) + (source.skinMode === 'preview' ? ' · 预览' : '');
      choose.append(wrap, title, type);
      listenRender(libraryCleanups, choose, 'click', () => requestSelection?.(source.id));
      const include = document.createElement('button');
      include.type = 'button'; include.className = 'skin-sidebar__tile-playlist'; include.title = '加入或移出轮播'; include.setAttribute('aria-label', include.title);
      include.appendChild(icon((cfg.rotation?.ids || []).includes(source.id) ? 'minus' : 'plus'));
      listenRender(libraryCleanups, include, 'click', () => {
        const rotation = cfg.rotation || (cfg.rotation = { enabled: false, ids: [], intervalSeconds: 300, transition: 'fade', durationMs: 500 });
        if (!Array.isArray(rotation.ids)) rotation.ids = [];
        rotation.ids = rotation.ids.includes(source.id) ? rotation.ids.filter(id => id !== source.id) : [...rotation.ids, source.id];
        if (rotation.ids.length < 2) rotation.enabled = false;
        onRotationChange?.(); persistSettings?.(); refresh();
      });
      tile.append(choose, include);
      library.appendChild(tile);
    }
    one('[data-action="clear-search"]').hidden = !search.value;
  };
  const refresh = () => {
    applyUi(); renderStatus(); renderDetails(); renderRanges(); renderPlaylist(); renderLibrary(); renderCrop(); renderIcons();
  };
  const refreshLibrary = error => {
    const scroll = one('.skin-sidebar__content');
    const top = scroll.scrollTop;
    renderPlaylist(); renderLibrary(); renderDetails(); renderIcons();
    scroll.scrollTop = top;
    refreshError = error ? '壁纸列表更新失败：' + String(error).slice(0, 300) : null;
    renderLibraryNotice();
  };
  const updateStatus = () => {
    renderStatus();
    renderDetails();
    renderIcons();
  };
  const changeZoom = amount => sendCrop({ zoom: Number(cfg.zoom) + amount, positionX: cfg.positionX, positionY: cfg.positionY });
  listen(root, 'click', event => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button)) return;
    if (button.dataset.material) { ui.material = button.dataset.material; saveUi(); applyUi(); return; }
    if (button.dataset.fit) { sendCrop({ fitMode: button.dataset.fit }); return; }
    if (button.dataset.filter) { filter = button.dataset.filter; for (const item of many('[data-filter]')) item.setAttribute('aria-pressed', String(item === button)); renderLibrary(); renderIcons(); return; }
    const action = button.dataset.action;
    if (action === 'copy-diagnostics') copyDiagnostics();
    if (action === 'close') { setOpen(false); toggle?.focus?.(); }
    if (action === 'open-settings') { beforeSettings = ui.tab; setSettings(true); }
    if (action === 'back-settings') { setSettings(false); setTab(beforeSettings); }
    if (action === 'reset-general') { Object.assign(ui, defaults, { tab: ui.tab }); saveUi(); applyUi(); }
    if (action === 'show-appearance') setTab('appearance');
    if (action === 'reset-appearance') {
      onSetting?.('panelOpacity', .2);
      onSetting?.('scrimOpacity', .1);
      onSetting?.('blurPx', 3);
      renderRanges();
    }
    if (action === 'crop-shrink') changeZoom(10);
    if (action === 'crop-expand') changeZoom(-10);
    if (action === 'crop-reset') sendCrop({ fitMode: 'contain', zoom: 100, positionX: 50, positionY: 50 });
    if (action === 'pause') onPause?.(cfg.userPaused !== true);
    if (action === 'refresh-library' && !isBusy?.()) { onRefreshPreview?.(); requestLibraryRefresh(); }
    if (action === 'clear-search' || action === 'reset-search') { search.value = ''; filter = 'all'; refresh(); }
    if (action === 'add-current' && current()) {
      const rotation = cfg.rotation || (cfg.rotation = { enabled: false, ids: [], intervalSeconds: 300, transition: 'fade', durationMs: 500 });
      if (!Array.isArray(rotation.ids)) rotation.ids = [];
      if (!rotation.ids.includes(cfg.currentId)) rotation.ids.push(cfg.currentId);
      onRotationChange?.(); persistSettings?.(); refresh();
    }
    if (action === 'previous' || action === 'next') {
      const ids = cfg.rotation?.ids || [];
      const index = ids.indexOf(cfg.currentId);
      if (ids.length > 1) requestSelection?.(ids[(index + (action === 'next' ? 1 : ids.length - 1)) % ids.length]);
    }
  });
  for (const tab of many('[role="tab"]')) listen(tab, 'click', () => setTab(tab.dataset.tab));
  listen(one('.skin-sidebar__tabs'), 'keydown', event => {
    const tabs = many('[role="tab"]');
    const index = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); setTab(tabs[next].dataset.tab); tabs[next].focus(); }
  });
  listen(search, 'input', renderLibrary);
  for (const input of many('[data-ui-setting]')) listen(input, 'change', () => {
    ui[input.dataset.uiSetting] = input.type === 'checkbox' ? input.checked : input.value;
    saveUi(); applyUi();
  });
  for (const input of many('[data-setting]')) listen(input, 'change', () => onSetting?.(input.dataset.setting, input.checked));
  for (const field of many('[data-field]')) for (const input of field.querySelectorAll('input')) listen(input, input.type === 'number' ? 'change' : 'input', () => {
    const name = field.dataset.field;
    const number = clamp(input.value, Number(input.min), Number(input.max), Number(field.querySelector('input[type="range"]').value));
    for (const peer of field.querySelectorAll('input')) peer.value = String(number);
    const value = name === 'volume' ? number / 100 : name === 'panelOpacity' || name === 'scrimOpacity' ? number / 100 : number;
    onSetting?.(name, value);
  });
  for (const input of many('[data-rotation]')) listen(input, 'change', () => {
    const rotation = cfg.rotation || (cfg.rotation = { enabled: false, ids: [], intervalSeconds: 300, transition: 'fade', durationMs: 500 });
    if (!Array.isArray(rotation.ids)) rotation.ids = [];
    if (input.dataset.rotation === 'enabled') rotation.enabled = input.checked && rotation.ids.length > 1;
    if (input.dataset.rotation === 'intervalSeconds') rotation.intervalSeconds = Number(input.value);
    if (input.dataset.rotation === 'transition') rotation.transition = input.value === 'none' ? 'none' : 'fade';
    onRotationChange?.(); persistSettings?.(); refresh();
  });
  const dragMove = event => {
    if (!dragging || event.pointerId !== dragging.id || !crop?.crop) return;
    const extent = dragging.extent;
    const rect = dragging.rect;
    if (!rect.width || !rect.height) return;
    const dx = (event.clientX - dragging.x) / rect.width * extent.width;
    const dy = (event.clientY - dragging.y) / rect.height * extent.height;
    const area = dragging.crop;
    const x = clamp(area.x + dx, 0, Math.max(0, 1 - area.width), area.x);
    const y = clamp(area.y + dy, 0, Math.max(0, 1 - area.height), area.y);
    sendCrop({ zoom: cfg.zoom, positionX: area.width >= 1 ? 50 : x / (1 - area.width) * 100, positionY: area.height >= 1 ? 50 : y / (1 - area.height) * 100 });
    cropFrame.dataset.drags = 'true';
    event.preventDefault();
  };
  const dragEnd = event => {
    if (!dragging || event.pointerId !== dragging.id) return;
    if (cropFrame.hasPointerCapture?.(dragging.id)) cropFrame.releasePointerCapture(dragging.id);
    dragging = null;
    cropFrame.removeAttribute('data-drags');
  };
  listen(cropFrame, 'pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !crop?.crop || Boolean(isBusy?.())) return;
    const extent = crop.extent || { x: 0, y: 0, width: 1, height: 1 };
    dragging = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      rect: cropPlane.getBoundingClientRect(),
      extent: { x: extent.x || 0, y: extent.y || 0, width: extent.width || 1, height: extent.height || 1 },
      crop: { x: crop.crop.x, y: crop.crop.y, width: crop.crop.width, height: crop.crop.height },
    };
    cropFrame.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  listen(cropFrame, 'pointermove', dragMove);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(cropFrame, name, dragEnd);
  listen(cropPreview, 'wheel', event => {
    if (event.ctrlKey || event.metaKey || !crop || Boolean(isBusy?.())) return;
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? 10 : -10);
  }, { passive: false });
  listen(cropFrame, 'keydown', event => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === '+' || event.key === '=') { changeZoom(-10); event.preventDefault(); return; }
    if (event.key === '-') { changeZoom(10); event.preventDefault(); return; }
    if (event.key === 'Home') { sendCrop({ fitMode: 'contain', zoom: 100, positionX: 50, positionY: 50 }); event.preventDefault(); return; }
    const x = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const y = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (x || y) { sendCrop({ zoom: cfg.zoom, positionX: Number(cfg.positionX) + x, positionY: Number(cfg.positionY) + y }); event.preventDefault(); }
  });
  const observer = typeof MutationObserver === 'function' && statusNode ? new MutationObserver(renderStatus) : null;
  observer?.observe(statusNode, { childList: true, characterData: true, subtree: true });
  if (observer) cleanups.push(() => observer.disconnect());
  const panelObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    const open = panel.style.display !== 'none';
    syncOpen(open);
  }) : null;
  panelObserver?.observe(panel, { attributes: true, attributeFilter: ['style'] });
  if (panelObserver) cleanups.push(() => panelObserver.disconnect());
  listen(window, 'resize', renderCrop);
  const media = safe(() => getMedia?.(), null);
  listen(media, 'load', renderCrop);
  listen(media, 'loadedmetadata', renderCrop);
  for (const name of ['play', 'playing', 'pause', 'seeked', 'loadeddata']) listen(media, name, syncMotion);
  listen(document, 'visibilitychange', syncMotion);
  const visibilityObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    previewInView = entries[0]?.isIntersecting !== false;
    syncMotion();
  }, { root: one('.skin-sidebar__content') }) : null;
  visibilityObserver?.observe(cropPreview);
  if (visibilityObserver) cleanups.push(() => visibilityObserver.disconnect());
  listen(document, 'pointerdown', event => {
    if (event.button !== 0 || panel.style.display === 'none' || controls.contains(event.target)) return;
    setOpen(false);
  }, { capture: true });
  const theme = safe(() => window.matchMedia?.('(prefers-color-scheme: dark)'), null);
  listen(theme, 'change', applyUi);
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || panel.style.display === 'none') return;
    if (settingsOpen) { setSettings(false); setTab(beforeSettings); } else { setOpen(false); toggle?.focus?.(); }
    event.preventDefault();
  });
  refresh();
  setTab(ui.tab);
  setSettings(false);
  setOpen(panel.style.display !== 'none');
  return {
    cleanup() {
      clear(libraryCleanups);
      clear(playlistCleanups);
      cleanups.reverse().forEach(fn => fn());
      style.remove();
      if (replacedStyleParent) {
        if (replacedStyleNext?.parentNode === replacedStyleParent) replacedStyleParent.insertBefore(replacedStyle, replacedStyleNext);
        else replacedStyleParent.appendChild(replacedStyle);
      }
      panel.replaceChildren(...original.children);
      panel.className = original.className;
      if (original.style === null) panel.removeAttribute('style'); else panel.setAttribute('style', original.style);
      if (toggle) toggle.hidden = original.hidden;
      for (const item of moved) {
        if (!item.parent) continue;
        if (item.next?.parentNode === item.parent) item.parent.insertBefore(item.node, item.next); else item.parent.appendChild(item.node);
      }
      controls.sidebarVersion = null;
    },
    refresh,
    refreshLibrary,
    resolveThumbnail,
    updateStatus,
    updateCrop: renderCrop,
    setOpen,
  };
}
