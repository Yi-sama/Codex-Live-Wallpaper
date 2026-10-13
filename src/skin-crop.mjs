export function wallpaperCrop({ width, height, viewportWidth, viewportHeight, fitMode = 'contain', zoom = 100, positionX = 50, positionY = 50 }) {
  if (![width, height, viewportWidth, viewportHeight, zoom].every(value => Number.isFinite(value) && value > 0)) return null;
  const ratio = (viewportWidth / viewportHeight) / (width / height);
  let cropWidth = 100 / zoom;
  let cropHeight = cropWidth;
  if (fitMode === 'contain') {
    cropWidth *= Math.max(1, ratio);
    cropHeight *= Math.max(1, 1 / ratio);
  } else {
    cropWidth *= Math.min(1, ratio);
    cropHeight *= Math.min(1, 1 / ratio);
  }
  return {
    x: (1 - cropWidth) * (cropWidth >= 1 ? .5 : positionX / 100),
    y: (1 - cropHeight) * (cropHeight >= 1 ? .5 : positionY / 100),
    width: cropWidth, height: cropHeight,
  };
}

// Serialized into CDP alongside the sidebar, including in already running bridges.
export function installSkinPresentation({ runtime, assets, installSidebar, installFeatures, calculateCrop }) {
  const controls = document.getElementById('codex-wallpaper-engine-skin-controls');
  if (!runtime || !controls || !document.createElement('template').content) return null;
  if (runtime.sidebar?.version === 7 && controls.sidebarVersion === 7) {
    runtime.sidebar.refresh();
    return runtime.sidebar;
  }
  const wasOpen = controls.children[1]?.style.display !== 'none';
  const previousPreview = runtime.sidebar?.getCropPreview?.();
  window.__codexWallpaperSidebarCleanup?.();
  const cfg = runtime.config;
  if (window.__codexWallpaperSidebarOwner) runtime.sidebarOwner = window.__codexWallpaperSidebarOwner;
  const toggle = controls.children[0];
  const panel = controls.children[1];
  panel.style.display = wasOpen ? 'block' : 'none';
  const listeners = [];
  const listen = (target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  };
  const statusNode = panel.querySelector('[data-skin-status]')
    || panel.children[cfg.sourceOptions.length ? 2 : 1];
  const progressNode = panel.querySelector('[role="progressbar"]');
  const diagnosticsNode = panel.querySelector('pre');
  const authorControls = [...new Set([...panel.querySelectorAll('[data-user-property]')].map(input => input.closest('label')))].filter(Boolean);
  const source = () => cfg.sourceOptions.find(item => item.id === cfg.currentId);
  const sceneOrigin = cfg.scenePageUrl ? new URL(cfg.scenePageUrl).origin : null;
  const getMedia = () => runtime.getMedia();
  const ownsRuntime = () => window.__codexWallpaperRuntime === runtime
    && (!runtime.sidebarOwner || (cfg.controllerId === runtime.sidebarOwner
      && runtime.controllers.includes(runtime.sidebarOwner)));
  const originalMediaStyles = new Map();
  const originalLayerBackground = runtime.layer.style.background;
  let scenePreview = cfg.mode === 'scene' && previousPreview?.url?.startsWith('data:image/')
    ? { dataUrl: previousPreview.url, sourceWidth: previousPreview.width, sourceHeight: previousPreview.height } : null;
  let sceneDimensions = null;
  let previewRequest = null;
  let previewError = null;
  let disposed = false;
  let ui = null;
  const dimensions = () => {
    const media = getMedia();
    if (media.tagName === 'VIDEO') return { width: media.videoWidth, height: media.videoHeight };
    if (media.tagName === 'IMG') return { width: media.naturalWidth, height: media.naturalHeight };
    if (media.tagName === 'CANVAS') return { width: media.width, height: media.height };
    return {
      width: source()?.sourceWidth || sceneDimensions?.width || scenePreview?.sourceWidth,
      height: source()?.sourceHeight || sceneDimensions?.height || scenePreview?.sourceHeight,
    };
  };
  const crop = zoom => calculateCrop({
    ...dimensions(), viewportWidth: innerWidth, viewportHeight: innerHeight,
    fitMode: cfg.fitMode, zoom: zoom ?? cfg.zoom, positionX: cfg.positionX, positionY: cfg.positionY,
  });
  const applyGeometry = () => {
    const selected = crop();
    if (!selected) return;
    const media = getMedia();
    if (!originalMediaStyles.has(media)) originalMediaStyles.set(media, media.getAttribute('style'));
    Object.assign(media.style, {
      position: 'absolute', maxWidth: 'none', maxHeight: 'none',
      width: innerWidth / selected.width + 'px', height: innerHeight / selected.height + 'px',
      left: -selected.x * innerWidth / selected.width + 'px',
      top: -selected.y * innerHeight / selected.height + 'px',
      objectFit: 'fill', objectPosition: 'center', transform: 'none',
    });
    runtime.layer.style.background = '#242827';
    ui?.updateCrop();
  };
  const persistSettings = () => {
    if (!ownsRuntime()) return;
    window.codexSkinCommand?.(JSON.stringify({
      action: 'settings', controllerId: runtime.sidebarOwner || cfg.controllerId, currentId: cfg.currentId,
      settings: runtime.snapshot().settings,
    }));
  };
  const requestSelection = id => {
    if (!ownsRuntime() || runtime.sidebarSelectionPending) return;
    if (!cfg.sourceOptions.some(item => item.id === id) || typeof window.codexSkinCommand !== 'function') return;
    const requestId = cfg.instanceId + ':' + (window.__codexWallpaperSelectionSequence =
      (window.__codexWallpaperSelectionSequence || 0) + 1);
    window.__codexWallpaperSelectionRequest = { requestId, id, claimedBy: null };
    runtime.sidebarSelectionPending = true;
    if (statusNode) statusNode.textContent = '\u6b63\u5728\u5207\u6362\u5e76\u51c6\u5907\u58c1\u7eb8\u2026';
    window.codexSkinCommand(JSON.stringify({
      action: runtime.sidebarOwner ? 'select' : 'select-request', requestId, id, currentId: cfg.currentId,
      controllerId: runtime.sidebarOwner || cfg.controllerId, settings: runtime.snapshot().settings,
    }));
  };
  const isBusy = () => {
    const state = runtime.snapshot();
    return !ownsRuntime() || runtime.sidebarSelectionPending || state.sceneLoading || state.videoLoading
      || (getMedia().tagName === 'VIDEO' && getMedia().readyState < 2)
      || !!window.__codexWallpaperSelectionRequest?.claimedBy
        && window.__codexWallpaperSelectionRequest.id !== cfg.currentId;
  };
  const updatePlayback = () => {
    const media = getMedia();
    if (media.tagName === 'VIDEO') {
      media.muted = cfg.muted;
      media.volume = cfg.volume;
      if (cfg.userPaused || document.hidden || !document.hasFocus()) media.pause();
      else if (media.src) media.play().catch(() => {});
    } else if (cfg.mode === 'scene' && runtime.sceneStatus?.state === 'ready') {
      media.contentWindow?.postMessage({
        type: 'codex-scene-playback', paused: !!cfg.userPaused || document.hidden || !document.hasFocus(),
        fitMode: 'contain', muted: cfg.muted, volume: cfg.volume,
        properties: Object.fromEntries(Object.entries(cfg.userPropertyValues || {}).map(([key, value]) => [key, { value }])),
      }, sceneOrigin);
    }
  };
  const requestScenePreview = () => {
    if (disposed || scenePreview || previewRequest || previewError
        || cfg.mode !== 'scene' || runtime.sceneStatus?.state !== 'ready') return;
    if (!ownsRuntime() || runtime.sidebarSelectionPending || !getMedia().contentWindow) return;
    previewRequest = String(cfg.instanceId || 'skin') + ':preview:'
      + (window.__codexWallpaperPreviewSequence = (window.__codexWallpaperPreviewSequence || 0) + 1);
    getMedia().contentWindow.postMessage({
      type: 'codex-scene-snapshot-request', requestId: previewRequest,
    }, sceneOrigin);
  };
  const getCropPreview = () => {
    const media = getMedia();
    const size = dimensions();
    const selected = crop();
    const live = ['VIDEO', 'CANVAS'].includes(media.tagName);
    const url = media.tagName === 'IMG' ? media.currentSrc || media.src
      : cfg.mode === 'scene' ? scenePreview?.dataUrl : null;
    if ((!url && !live) || !selected) return null;
    const base = crop(100);
    return {
      url, live, ...size, crop: selected,
      extent: {
        width: Math.max(1, base.width, selected.width), height: Math.max(1, base.height, selected.height),
        x: Math.min(0, (1 - Math.max(base.width, selected.width)) / 2),
        y: Math.min(0, (1 - Math.max(base.height, selected.height)) / 2),
      },
    };
  };
  const onSetting = (name, value) => {
    if (!ownsRuntime()) return;
    cfg[name] = value;
    document.documentElement.style.setProperty('--codex-skin-panel-opacity', cfg.panelOpacity);
    document.documentElement.style.setProperty('--codex-skin-blur', cfg.blurPx + 'px');
    const scrim = runtime.layer.lastElementChild;
    if (scrim !== getMedia()) scrim.style.background = 'rgba(0,0,0,' + cfg.scrimOpacity + ')';
    const blur = document.getElementById('codex-wallpaper-engine-skin-blur');
    if (blur) blur.style.backdropFilter = 'blur(' + cfg.blurPx + 'px) saturate(1.12)';
    applyGeometry();
    updatePlayback();
    persistSettings();
  };
  const onCrop = values => {
    if (!ownsRuntime()) return;
    if (values.fitMode !== undefined) cfg.fitMode = values.fitMode === 'cover' ? 'cover' : 'contain';
    for (const [name, min, max] of [['zoom', 100, 400], ['positionX', 0, 100], ['positionY', 0, 100]]) {
      if (Number.isFinite(values[name])) cfg[name] = Math.max(min, Math.min(max, Math.round(values[name])));
    }
    applyGeometry();
    persistSettings();
  };
  const onPause = paused => {
    if (!ownsRuntime()) return;
    cfg.userPaused = paused === true;
    window.__codexWallpaperSyncPlayback?.();
    updatePlayback();
    ui?.updateStatus?.();
  };
  const originalVideo = getMedia().tagName === 'VIDEO' ? getMedia() : null;
  const previousPlay = originalVideo?.play;
  if (previousPlay) {
    originalVideo.play = function (...args) {
      return cfg.userPaused ? Promise.resolve() : previousPlay.apply(this, args);
    };
    listeners.push(() => { originalVideo.play = previousPlay; });
  }
  window.__codexWallpaperFeaturesCleanup?.();
  const featureCleanup = installFeatures({
    cfg, panel: null, requestSelection, persistSettings, getMedia, sceneOrigin,
    isBusy: () => !!cfg.userPaused || isBusy(),
  });
  window.__codexWallpaperFeaturesCleanup = featureCleanup;
  ui = installSidebar({
    cfg, controls, toggle, panel, assets, statusNode, progressNode, diagnosticsNode, authorControls,
    getMedia, getCropPreview, getCropPreviewError: () => previewError, getPlaybackState: () => runtime.snapshot(),
    onRefreshPreview: () => { previewError = null; requestScenePreview(); },
    onSetting, onCrop, onPause, requestSelection, persistSettings,
    onRotationChange: () => featureCleanup.schedule(), isBusy,
  });
  listen(window, 'resize', applyGeometry);
  for (const name of ['loadedmetadata', 'loadeddata', 'load']) listen(getMedia(), name, () => {
    applyGeometry(); ui?.updateCrop();
  });
  for (const [target, name] of [[window, 'focus'], [window, 'blur'], [document, 'visibilitychange']]) {
    listen(target, name, updatePlayback);
  }
  listen(window, 'message', event => {
    if (event.origin !== sceneOrigin || event.source !== getMedia().contentWindow) return;
    const info = event.data?.diagnostics || event.data;
    if (Number.isFinite(info?.sourceWidth) && info.sourceWidth > 0
        && Number.isFinite(info?.sourceHeight) && info.sourceHeight > 0) {
      sceneDimensions = { width: info.sourceWidth, height: info.sourceHeight };
      applyGeometry();
    }
    if (event.data?.type === 'codex-scene-ready') {
      applyGeometry();
      requestScenePreview();
    }
    if (event.data?.type === 'codex-scene-error') {
      previewRequest = null;
      previewError = String(event.data.message || 'Scene renderer failed').slice(0, 300);
      ui?.updateCrop();
    }
    if (event.data?.type === 'codex-scene-snapshot' && event.data.requestId === previewRequest
        && typeof event.data.dataUrl === 'string' && event.data.dataUrl.startsWith('data:image/')) {
      scenePreview = event.data;
      previewRequest = null;
      applyGeometry();
    }
    if (event.data?.type === 'codex-scene-snapshot-error' && event.data.requestId === previewRequest) {
      previewRequest = null;
      previewError = String(event.data.message || 'Scene snapshot unavailable').slice(0, 300);
      ui?.updateCrop();
    }
  });
  const observer = new MutationObserver(() => {
    if (runtime.failed) runtime.sidebarSelectionPending = false;
    ui?.updateStatus?.();
  });
  if (statusNode) observer.observe(statusNode, { childList: true, characterData: true, subtree: true });
  listeners.push(() => observer.disconnect());
  applyGeometry();
  requestScenePreview();
  let previewTimer = window.setInterval(() => {
    if (cfg.mode === 'scene' && panel.style.display !== 'none' && !document.hidden) {
      applyGeometry();
      requestScenePreview();
    }
  }, 3000);
  const cleanup = () => {
    disposed = true;
    window.clearInterval(previewTimer);
    previewTimer = null;
    listeners.reverse().forEach(dispose => dispose());
    ui?.cleanup();
    featureCleanup();
    for (const [media, style] of originalMediaStyles) {
      if (style === null) media.removeAttribute('style'); else media.setAttribute('style', style);
    }
    runtime.layer.style.background = originalLayerBackground;
    if (runtime.sidebar === api) runtime.sidebar = null;
  };
  const api = { version: 7, refresh: () => { applyGeometry(); ui.refresh(); },
    refreshLibrary: ui.refreshLibrary, resolveThumbnail: ui.resolveThumbnail,
    cleanup, getCropPreview, applyGeometry, setOpen: ui.setOpen };
  runtime.sidebar = api;
  window.__codexWallpaperSidebarCleanup = cleanup;
  return api;
}
