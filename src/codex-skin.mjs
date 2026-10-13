import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateWallpaperSources, resolveUserPropertyValues } from './wallpaper-engine.mjs';
import { SceneRuntimeServer } from './scene-runtime.mjs';
import { installSkinFeatures, normalizeRotation } from './skin-controls.mjs';
import { installSkinRope } from './skin-rope.mjs';
import { wallpaperCrop, installSkinPresentation } from './skin-crop.mjs';
import { installSkinSidebar, SIDEBAR_ASSETS } from './skin-sidebar.mjs';

const DEFAULT_CDP_PORT = Number(process.env.CODEX_SKIN_CDP_PORT || 0);
const LAYER_ID = 'codex-wallpaper-engine-skin';
const ROPE_IMAGE_URL = 'data:image/png;base64,' + readFileSync(new URL('./assets/skin-mascot.png', import.meta.url)).toString('base64');
const SKIN_DATA_ROOT = process.env.CODEX_SKIN_DATA_DIR
  || join(process.env.LOCALAPPDATA || tmpdir(), 'CodexWallpaperEngineSkin');
const DEFAULT_STATE_FILE = join(SKIN_DATA_ROOT, 'state.json');
const DEFAULT_DEBUG_ENDPOINT_FILE = join(SKIN_DATA_ROOT, 'debug-endpoint.json');

function resolveDebugPort(requestedPort, endpointFile) {
  let port = requestedPort;
  if (port === 0) {
    let record;
    try {
      record = JSON.parse(readFileSync(endpointFile, 'utf8'));
    } catch {
      throw new Error('Automatic debug port is not published yet. Relaunch Codex with the Wallpaper Skin launcher.');
    }
    port = record?.port;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('No valid debug port is available yet. Wait for the Wallpaper Skin launcher to finish.');
  }
  return port;
}

export function readSavedSkinState(file = DEFAULT_STATE_FILE) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || value.enabled !== true || typeof value.id !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

export function writeSavedSkinState(value, file = DEFAULT_STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(partial, file);
}

export function clearSavedSkinState(file = DEFAULT_STATE_FILE) {
  rmSync(file, { force: true });
}

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream';
}

export function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function inlineMedia(file, maxBytes) {
  if (!file || !existsSync(file)) throw new Error('The selected project media is missing.');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Media is too large to embed safely (${stat.size} bytes).`);
  return `data:${mimeFor(file)};base64,${readFileSync(file).toString('base64')}`;
}

function extractVideoAnimation(file) {
  const workDir = mkdtempSync(join(tmpdir(), 'codex-skin-frame-'));
  const output = join(workDir, 'frames');
  const script = fileURLToPath(new URL('../scripts/extract-video-frames.ps1', import.meta.url));
  try {
    const rawMetadata = execFileSync('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
      '-InputPath', file, '-OutputDirectory', output,
      '-FrameCount', '60', '-DurationSeconds', '4', '-MaxWidth', '1280', '-JpegQuality', '75',
    ], { encoding: 'utf8', windowsHide: true, timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const metadata = JSON.parse(rawMetadata);
    const files = readdirSync(output).filter((name) => /\.jpg$/i.test(name)).sort();
    if (files.length < 4) throw new Error('Too few decoded video frames.');
    const totalBytes = files.reduce((sum, name) => sum + statSync(join(output, name)).size, 0);
    if (totalBytes > 48 * 1024 * 1024) throw new Error('Decoded animation is too large to embed safely.');
    const mediaFrames = files.map((name) => inlineMedia(join(output, name), 4 * 1024 * 1024));
    return {
      mediaUrl: mediaFrames[0], mediaFrames, frameDelayMs: metadata.frameDelayMs,
      frameRate: metadata.frameRate,
      sourceResolution: `${metadata.sourceWidth}x${metadata.sourceHeight}`,
      renderResolution: `${metadata.renderWidth}x${metadata.renderHeight}`,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function transcodeVideoForCodex(file) {
  const source = statSync(file);
  const minimumBytes = Math.max(1, Number(process.env.CODEX_SKIN_COMPRESS_MIN_MB || 48)) * 1024 * 1024;
  if (process.env.CODEX_SKIN_DISABLE_COMPRESSION === '1' || source.size < minimumBytes) return null;
  const cacheRoot = join(SKIN_DATA_ROOT, 'transcoded');
  mkdirSync(cacheRoot, { recursive: true });
  const settings = { maxWidth: 2560, maxHeight: 1440, bitrateKbps: 10000, frameRate: 30, audio: 'preserve-aac-v1' };
  const key = createHash('sha256')
    .update(`${resolve(file)}\n${source.size}\n${source.mtimeMs}\n${JSON.stringify(settings)}`)
    .digest('hex').slice(0, 24);
  const output = join(cacheRoot, `${key}.mp4`);
  const metadataFile = join(cacheRoot, `${key}.json`);
  if (existsSync(output) && statSync(output).size > 0 && existsSync(metadataFile)) {
    return { filePath: output, ...JSON.parse(readFileSync(metadataFile, 'utf8')), cached: true };
  }
  const partial = join(cacheRoot, `${key}.${process.pid}.partial.mp4`);
  const script = fileURLToPath(new URL('../scripts/transcode-video.ps1', import.meta.url));
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-InputPath', file, '-OutputPath', partial,
      '-MaxWidth', String(settings.maxWidth), '-MaxHeight', String(settings.maxHeight),
      '-VideoBitrateKbps', String(settings.bitrateKbps), '-MaxFrameRate', String(settings.frameRate),
    ], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const metadata = JSON.parse(raw);
    if (!existsSync(partial) || statSync(partial).size < 1024) throw new Error('The compressed video output is empty.');
    renameSync(partial, output);
    const result = {
      originalBytes: source.size,
      outputBytes: statSync(output).size,
      sourceResolution: `${metadata.sourceWidth}x${metadata.sourceHeight}`,
      renderResolution: `${metadata.outputWidth}x${metadata.outputHeight}`,
      frameRate: metadata.frameRate,
      bitrateKbps: metadata.bitrateKbps,
      hasAudio: metadata.hasAudio,
      audioCodec: metadata.audioCodec,
    };
    writeFileSync(metadataFile, JSON.stringify(result));
    return { filePath: output, ...result, cached: false };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

export function selectEmbeddableMedia(project) {
  const maxVideoBytes = Math.max(1, Number(process.env.CODEX_SKIN_INLINE_VIDEO_MAX_MB || 24)) * 1024 * 1024;
  const maxBlobVideoBytes = Math.max(32, Number(process.env.CODEX_SKIN_BLOB_VIDEO_MAX_MB || 512)) * 1024 * 1024;
  if (project.isStatic && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(project.filePath || '')) {
    return { mediaUrl: inlineMedia(project.filePath, 24 * 1024 * 1024), mode: 'preview', fallback: false, fallbackKind: null };
  }
  if (project.type === 'scene' && project.filePath?.toLowerCase().endsWith('.pkg')
      && existsSync(project.filePath) && statSync(project.filePath).isFile()) {
    return {
      mediaUrl: project.previewPath ? inlineMedia(project.previewPath, 24 * 1024 * 1024) : null,
      mode: 'scene',
      fallback: false,
      fallbackKind: null,
      sceneFilePath: project.filePath,
      sceneProjectPath: project.projectPath,
    };
  }
  if (project.type === 'video' && existsSync(project.filePath) && statSync(project.filePath).size <= maxVideoBytes) {
    return { mediaUrl: inlineMedia(project.filePath, maxVideoBytes), mode: 'video', fallback: false, fallbackKind: null };
  }
  let compressed = null;
  if (project.type === 'video' && existsSync(project.filePath)) {
    try { compressed = transcodeVideoForCodex(project.filePath); } catch { /* use the original video */ }
  }
  const blobVideoPath = compressed?.filePath || project.filePath;
  if (project.type === 'video' && process.env.CODEX_SKIN_DISABLE_BLOB_VIDEO !== '1'
      && existsSync(blobVideoPath) && statSync(blobVideoPath).size <= maxBlobVideoBytes) {
    const poster = project.previewPath ? inlineMedia(project.previewPath, 24 * 1024 * 1024) : null;
    return {
      mediaUrl: poster, mode: 'video-blob', fallback: false, fallbackKind: null,
      videoPath: blobVideoPath, videoBytes: statSync(blobVideoPath).size,
      compressed: Boolean(compressed), originalBytes: compressed?.originalBytes || null,
      compressionRatio: compressed ? compressed.outputBytes / compressed.originalBytes : null,
      sourceResolution: compressed?.sourceResolution || null,
      renderResolution: compressed?.renderResolution || null,
      frameRate: compressed?.frameRate || null,
      bitrateKbps: compressed?.bitrateKbps || null,
      compressionCached: compressed?.cached || false,
      hasAudio: compressed?.hasAudio ?? null,
    };
  }
  if (project.type === 'video' && process.env.CODEX_SKIN_DISABLE_FRAME_EXTRACTION !== '1') {
    try {
      const animation = extractVideoAnimation(project.filePath);
      return { ...animation, mode: 'frames', fallback: true, fallbackKind: 'extracted-video-animation' };
    } catch { /* fall through to the project preview */ }
  }
  if (project.previewPath) {
    return { mediaUrl: inlineMedia(project.previewPath, 24 * 1024 * 1024), mode: 'preview', fallback: project.type !== 'scene', fallbackKind: 'project-preview' };
  }
  throw new Error('Codex blocks local media URLs and this project has no embeddable preview image.');
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.scriptId = null;
    this.onEvent = null;
  }

  async connect() {
    if (typeof WebSocket !== 'function') throw new Error('Node.js 22 or newer is required for the skin bridge.');
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the Codex debug target.')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the Codex debug target.')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method) {
        try { this.onEvent?.(message); } catch { /* isolate event handlers from CDP calls */ }
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: done, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else done(message.result || {});
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Codex debug target disconnected.'));
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex debug target is not connected.');
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket?.close(); } catch { /* ignore */ }
  }
}

export function makeSidebarUpgradeScript(controllerId = null) {
  return `(() => {
    if (!document.createElement('template').content) return { upgraded: false };
    const runtime = window.__codexWallpaperRuntime;
    const owner = ${JSON.stringify(controllerId)};
    if (owner && runtime?.config.controllerId === owner && runtime.controllers.includes(owner)) {
      const session = window.__codexWallpaperSidebarSession;
      if (session?.controllerId === owner) session.runtime = runtime;
      const pinned = session?.runtime === runtime && runtime.controllers.includes(session.controllerId);
      runtime.sidebarOwner = pinned ? session.controllerId : owner;
      window.__codexWallpaperSidebarOwner = runtime.sidebarOwner;
    }
    if (!window.__codexWallpaperLucide) {
      const previousIcons = globalThis.lucide;
      ${SIDEBAR_ASSETS.icons}
      window.__codexWallpaperLucide = globalThis.lucide;
      globalThis.lucide = previousIcons;
    }
    const installSidebar = ${installSkinSidebar.toString()};
    const installPresentation = ${installSkinPresentation.toString()};
    const installFeatures = ${installSkinFeatures.toString()};
    const calculateCrop = ${wallpaperCrop.toString()};
    const assets = ${JSON.stringify({ html: SIDEBAR_ASSETS.html, css: SIDEBAR_ASSETS.css })};
    window.__codexWallpaperEnsureSidebar = () => installPresentation({
      runtime: window.__codexWallpaperRuntime, assets, installSidebar, installFeatures, calculateCrop,
    });
    window.__codexWallpaperSidebarWatchCleanup?.();
    const observer = new MutationObserver(() => window.__codexWallpaperEnsureSidebar());
    observer.observe(document.body, { childList: true });
    window.__codexWallpaperSidebarWatchCleanup = () => observer.disconnect();
    const sidebar = window.__codexWallpaperEnsureSidebar();
    return { upgraded: !!sidebar, version: sidebar?.version || null };
  })()`;
}

export function makeInjectionScript({ mediaUrl, mediaFrames = [], frameDelayMs = 250, mode, sceneRendererUrl = null, scenePageUrl = null, sceneSourceUrl = null, sceneProjectUrl = null, panelOpacity = 0.2, scrimOpacity = 0.1, blurPx = 3, muted = true, volume = 0.3, fitMode = 'contain', zoom = 100, positionX = 50, positionY = 50, showControls = true, sourceOptions = [], currentId = null, userProperties = [], userPropertyValues = {}, rotation = {}, mouseEnabled = false, controllerId = null, instanceId = null, reuseExisting = false, selectionRequestId = null }) {
  volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.3;
  rotation = normalizeRotation(rotation, sourceOptions);
  const config = JSON.stringify({ mediaUrl, mediaFrames, frameDelayMs, mode, sceneRendererUrl, scenePageUrl, sceneSourceUrl, sceneProjectUrl, panelOpacity, scrimOpacity, blurPx, muted, volume, fitMode, zoom, positionX, positionY, showControls, sourceOptions, currentId, userProperties, userPropertyValues, rotation, mouseEnabled: mouseEnabled === true, controllerId, instanceId });
  return `(() => {
    if (${JSON.stringify(selectionRequestId)} !== null
        && window.__codexWallpaperSelectionRequest?.requestId !== ${JSON.stringify(selectionRequestId)}) {
      return { superseded: true };
    }
    const cfg = ${config};
    const id = ${JSON.stringify(LAYER_ID)};
    const installRope = ${installSkinRope.toString()};
    const ropeImageUrl = ${JSON.stringify(ROPE_IMAGE_URL)};
    const existing = window.__codexWallpaperRuntime;
    const controllers = (existing?.controllers || []).filter(value => value !== cfg.controllerId);
    controllers.push(cfg.controllerId);
    if (${Boolean(reuseExisting)} && (typeof cfg.currentId === 'string' || cfg.mode === 'picker')
        && existing?.config.currentId === cfg.currentId && existing.sourceMode === cfg.mode
        && existing.restoreVersion === 4
        && Number.isFinite(existing.config.volume)
        && (cfg.mode !== 'scene' || existing.sceneDiagnosticsVersion === 1)
        && existing.layer === document.getElementById(id)
        && existing.getMedia().isConnected && !existing.getMedia().error && !existing.failed) {
      const sidebarSession = window.__codexWallpaperSidebarSession;
      existing.config.controllerId = sidebarSession?.runtime === existing
        && existing.controllers.includes(sidebarSession.controllerId)
        ? sidebarSession.controllerId : cfg.controllerId;
      existing.controllers = controllers;
      const controls = document.getElementById(id + '-controls');
      if (controls && controls.ropeVersion !== 4) {
        window.__codexWallpaperRopeCleanup?.();
        window.__codexWallpaperRopeCleanup = installRope({
          controls, toggle: controls.children[0], panel: controls.children[1], imageUrl: ropeImageUrl,
        });
      }
      // A chat bridge can disappear while the launcher-owned sidebar remains alive.
      if (existing.config.controllerId === cfg.controllerId
          && JSON.stringify(existing.config.sourceOptions) !== JSON.stringify(cfg.sourceOptions)) {
        existing.config.sourceOptions = cfg.sourceOptions;
        const search = [...(document.getElementById(id + '-controls')?.querySelectorAll('input') || [])]
          .find(input => input.type === 'search');
        const grid = search && [...search.parentElement.parentElement.children].at(-1);
        const scrollTop = grid?.scrollTop;
        search?.dispatchEvent(new Event('input'));
        if (grid) grid.scrollTop = scrollTop;
      }
      window.__codexWallpaperSyncPlayback?.();
      ${makeSidebarUpgradeScript(controllerId)};
      return { ...existing.snapshot(), reused: true };
    }
    window.__codexWallpaperFeaturesCleanup?.();
    window.__codexWallpaperSidebarCleanup?.();
    window.__codexWallpaperRopeCleanup?.();
    window.__codexWallpaperRopeCleanup = null;
    window.__codexWallpaperTransitionCleanup?.();
    const priorState = existing?.snapshot();
    const outgoing = existing && existing.config.currentId !== cfg.currentId && cfg.rotation.transition === 'fade'
      && !existing.failed && !priorState.videoLoading && !priorState.sceneLoading && !document.hidden
      && existing.layer.isConnected ? existing.layer : null;
    const outgoingBlob = outgoing ? window.__codexWallpaperBlobUrl : null;
    existing?.suspend?.();
    if (outgoing) outgoing.id = id + '-outgoing';
    window.__codexWallpaperRuntime = null;
    document.getElementById(id)?.remove();
    document.getElementById(id + '-blur')?.remove();
    document.getElementById(id + '-style')?.remove();
    document.getElementById(id + '-controls')?.remove();
    window.__codexWallpaperPauseCleanup?.();
    window.__codexWallpaperSceneMessageCleanup?.();
    if (window.__codexWallpaperFrameTimer) cancelAnimationFrame(window.__codexWallpaperFrameTimer);
    window.__codexWallpaperFrameCache = null;
    if (window.__codexWallpaperBlobUrl && !outgoingBlob) URL.revokeObjectURL(window.__codexWallpaperBlobUrl);
    window.__codexWallpaperBlobUrl = null;
    window.__codexWallpaperVideoChunks = null;

    const rootStyle = document.documentElement.style;
    if (cfg.mode !== 'picker') {
      rootStyle.setProperty('--codex-skin-panel-opacity', cfg.panelOpacity);
      rootStyle.setProperty('--codex-skin-blur', cfg.blurPx + 'px');
    }

    const layer = document.createElement('div');
    layer.id = id;
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '0', overflow: 'hidden', pointerEvents: 'none', background: '#0b0d10' });
    let transitionTimer = null;
    let transitionStarted = false;
    const finishTransition = () => {
      if (transitionTimer !== null) window.clearTimeout(transitionTimer);
      outgoing?.remove();
      if (outgoingBlob) URL.revokeObjectURL(outgoingBlob);
      layer.style.opacity = '1';
      layer.style.transition = '';
      window.__codexWallpaperTransitionCleanup = null;
    };
    const revealNew = () => {
      if (!outgoing || transitionStarted) return;
      transitionStarted = true;
      if (document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finishTransition();
        return;
      }
      layer.style.transition = 'opacity ' + cfg.rotation.durationMs + 'ms ease';
      layer.style.opacity = '1';
      transitionTimer = window.setTimeout(finishTransition, cfg.rotation.durationMs);
    };
    if (outgoing) {
      // A nonzero starting opacity lets remote Scene frames produce their first frame.
      layer.style.opacity = '0.001';
      window.__codexWallpaperTransitionCleanup = finishTransition;
    }
    let media;
    let resumeFrames = null;
    const sceneStatus = cfg.mode === 'scene' ? { state: 'loading', error: null } : null;
    const sceneOrigin = cfg.scenePageUrl ? new URL(cfg.scenePageUrl).origin : null;
    if (cfg.mode === 'frames') {
      media = document.createElement('canvas');
    } else if (cfg.mode === 'video' || cfg.mode === 'video-blob') {
      media = document.createElement('video');
      media.autoplay = true; media.loop = true; media.muted = cfg.muted; media.playsInline = true;
    } else if (cfg.mode === 'web' || cfg.mode === 'scene') {
      media = document.createElement('iframe');
      media.sandbox = 'allow-scripts allow-same-origin';
      media.allow = 'autoplay';
      media.tabIndex = -1;
    } else {
      media = document.createElement('img');
    }
    if (cfg.mode === 'scene') {
      media.src = cfg.scenePageUrl + '?paused=' + Number(document.hidden || !document.hasFocus()) + '&fit=' + encodeURIComponent(cfg.fitMode)
        + '&muted=' + Number(cfg.muted) + '&volume=' + cfg.volume;
    } else if (cfg.mode === 'video-blob') {
      if (cfg.mediaUrl) media.poster = cfg.mediaUrl;
    } else if (cfg.mode !== 'frames') {
      media.src = cfg.mediaUrl;
    }
    const styleMedia = target => Object.assign(target.style, {
      width: '100%', height: '100%', objectFit: cfg.fitMode,
      objectPosition: cfg.positionX + '% ' + cfg.positionY + '%',
      transform: 'scale(' + (cfg.zoom / 100) + ')', transformOrigin: 'center',
      border: '0', pointerEvents: 'none', imageRendering: 'auto'
    });
    styleMedia(media);
    let sceneDiagnostics = null;
    let sceneDiagnosticText = null;
    const renderSceneDiagnostics = () => {
      if (sceneDiagnosticText) sceneDiagnosticText.textContent = JSON.stringify({
        id: cfg.currentId, requestedMode: 'scene', actualMode: cfg.mode,
        inactive: document.hidden || !document.hasFocus(), error: sceneStatus?.error,
        ...sceneDiagnostics,
      }, null, 2);
    };
    const fallbackToPreview = message => {
      if (cfg.mode !== 'scene') return;
      sceneStatus.state = 'error';
      sceneStatus.error = String(message || 'Scene initialization failed.');
      window.__codexWallpaperRuntime.failed = true;
      window.__codexWallpaperSceneMessageCleanup?.();
      if (cfg.mediaUrl) {
        const preview = document.createElement('img');
        preview.alt = '';
        preview.src = cfg.mediaUrl;
        styleMedia(preview);
        media.replaceWith(preview);
        media = preview;
        cfg.mode = 'preview';
      } else media.remove();
      revealNew();
      if (playbackStatus) playbackStatus.textContent = 'Scene 加载失败' + (cfg.mediaUrl ? '，已回退到预览图' : '') + '：' + sceneStatus.error;
      setLoadingProgress(100, 'error');
      renderSceneDiagnostics();
    };
    if (cfg.mode === 'scene') {
      const sceneMessageHandler = event => {
        if (event.origin !== sceneOrigin
            || !['codex-scene-error', 'codex-scene-ready', 'codex-scene-diagnostics'].includes(event.data?.type)) return;
        if (event.source !== media.contentWindow) return;
        if (event.data.type === 'codex-scene-diagnostics') {
          sceneDiagnostics = event.data.diagnostics;
          renderSceneDiagnostics();
          syncPlayback(true);
        }
        if (event.data?.type === 'codex-scene-error') fallbackToPreview(event.data.message);
        if (event.data?.type === 'codex-scene-ready') {
          sceneStatus.state = 'ready';
          setLoadingProgress(100, 'done');
          syncPlayback();
          revealNew();
        }
      };
      const scenePolicyHandler = event => {
        if (sceneStatus.state !== 'loading' || event.disposition === 'report'
            || !['frame-src', 'child-src', 'default-src'].includes(event.effectiveDirective)) return;
        if (event.blockedURI === sceneOrigin || event.blockedURI?.startsWith(sceneOrigin + '/')) {
          fallbackToPreview('Codex 安全策略阻止了场景页面。请通过 Codex Wallpaper Skin 快捷方式完成启动初始化。');
        }
      };
      window.addEventListener('message', sceneMessageHandler);
      document.addEventListener('securitypolicyviolation', scenePolicyHandler);
      window.__codexWallpaperSceneMessageCleanup = () => {
        window.removeEventListener('message', sceneMessageHandler);
        document.removeEventListener('securitypolicyviolation', scenePolicyHandler);
      };
    }
    if (cfg.mode === 'frames' && cfg.mediaFrames.length > 1) {
      const frames = cfg.mediaFrames.map(src => { const image = new Image(); image.decoding = 'async'; image.src = src; return image; });
      window.__codexWallpaperFrameCache = frames;
      const context = media.getContext('2d', { alpha: false });
      let canvasSized = false;
      const draw = image => {
        if (!canvasSized) { media.width = image.naturalWidth; media.height = image.naturalHeight; canvasSized = true; }
        context.drawImage(image, 0, 0, media.width, media.height);
        revealNew();
      };
      if (frames[0].complete) draw(frames[0]); else frames[0].addEventListener('load', () => draw(frames[0]), { once: true });
      Promise.allSettled(frames.map(image => image.decode())).then(() => {
        const delay = Math.max(33, cfg.frameDelayMs);
        let frameIndex = 0;
        let previousTime = performance.now();
        const renderFrame = now => {
          if (codexInactive()) { window.__codexWallpaperFrameTimer = null; return; }
          if (now - previousTime >= delay) {
            frameIndex = (frameIndex + Math.max(1, Math.floor((now - previousTime) / delay))) % frames.length;
            previousTime = now;
          }
          if (frames[frameIndex].complete) {
            draw(frames[frameIndex]);
          }
          window.__codexWallpaperFrameTimer = requestAnimationFrame(renderFrame);
        };
        resumeFrames = () => {
          if (window.__codexWallpaperFrameTimer || codexInactive()) return;
          previousTime = performance.now();
          window.__codexWallpaperFrameTimer = requestAnimationFrame(renderFrame);
        };
        resumeFrames();
      });
    }
    layer.appendChild(media);
    const scrim = document.createElement('div');
    Object.assign(scrim.style, { position: 'absolute', inset: '0', background: 'rgba(0,0,0,' + cfg.scrimOpacity + ')' });
    layer.appendChild(scrim);
    const blurLayer = document.createElement('div');
    blurLayer.id = id + '-blur';
    Object.assign(blurLayer.style, {
      position: 'fixed', inset: '0', zIndex: '0', pointerEvents: 'none',
      backdropFilter: 'blur(' + cfg.blurPx + 'px) saturate(1.12)'
    });

    let playbackStatus = null;
    let playbackProgressTrack = null;
    let playbackProgressFill = null;
    let selectionPending = false;
    let finishedVideoToken = null;
    let controlsPanel = null;
    const requestSelection = selectedId => {
      if (typeof window.codexSkinCommand !== 'function') return;
      selectionPending = true;
      if (playbackStatus) playbackStatus.textContent = '正在切换并准备壁纸…';
      setLoadingProgress(null);
      const requestId = cfg.instanceId + ':' + (window.__codexWallpaperSelectionSequence =
        (window.__codexWallpaperSelectionSequence || 0) + 1);
      window.__codexWallpaperSelectionRequest = { requestId, id: selectedId, claimedBy: null };
      window.codexSkinCommand(JSON.stringify({
        action: 'select-request', requestId, id: selectedId, currentId: cfg.currentId, controllerId: cfg.controllerId,
        settings: window.__codexWallpaperRuntime.snapshot().settings
      }));
    };
    const persistSettings = () => {
      if (typeof window.codexSkinCommand !== 'function') return;
      window.codexSkinCommand(JSON.stringify({
        action: 'settings', controllerId: cfg.controllerId, currentId: cfg.currentId,
        settings: window.__codexWallpaperRuntime.snapshot().settings
      }));
    };
    const setLoadingProgress = (percent, state = 'loading') => {
      if (!playbackProgressTrack || !playbackProgressFill) return;
      playbackProgressTrack.style.display = 'block';
      playbackProgressFill.style.background = state === 'error' ? '#ef5350' : (state === 'done' ? '#45c97a' : '#4aa3ff');
      if (percent === null) {
        playbackProgressTrack.removeAttribute('aria-valuenow');
        playbackProgressFill.style.width = '28%';
        playbackProgressFill.style.transform = 'translateX(-140%)';
        playbackProgressFill.style.animation = 'codex-skin-progress-indeterminate 1.1s ease-in-out infinite';
      } else {
        playbackProgressTrack.setAttribute('aria-valuemin', '0');
        playbackProgressTrack.setAttribute('aria-valuemax', '100');
        playbackProgressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
        playbackProgressFill.style.animation = 'none';
        playbackProgressFill.style.transform = 'none';
        playbackProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
      }
    };
    const codexInactive = () => document.hidden || !document.hasFocus();
    const syncPlayback = (statusOnly = false) => {
      if (!statusOnly && media instanceof HTMLVideoElement) {
        media.muted = cfg.muted;
        media.volume = cfg.volume;
        if (codexInactive() || cfg.userPaused) media.pause();
        else if (media.src) media.play().catch(() => {});
      }
      if (!statusOnly && cfg.mode === 'scene' && sceneStatus.state === 'ready') {
        media.contentWindow?.postMessage({ type: 'codex-scene-playback', paused: codexInactive() || !!cfg.userPaused,
          fitMode: window.__codexWallpaperRuntime?.sidebar ? 'contain' : cfg.fitMode,
          muted: cfg.muted, volume: cfg.volume,
          properties: Object.fromEntries(Object.entries(cfg.userPropertyValues).map(([key, value]) => [key, { value }])) }, sceneOrigin);
      }
      if (!statusOnly && cfg.mode === 'frames') {
        if ((codexInactive() || cfg.userPaused) && window.__codexWallpaperFrameTimer) {
          cancelAnimationFrame(window.__codexWallpaperFrameTimer);
          window.__codexWallpaperFrameTimer = null;
        } else if (!codexInactive() && !cfg.userPaused) resumeFrames?.();
      }
      if (playbackStatus && selectionPending) {
        playbackStatus.textContent = '正在切换并准备壁纸…';
      } else if (playbackStatus && sceneStatus?.state === 'loading') {
        playbackStatus.textContent = document.hidden ? 'Scene 等待窗口显示后完成加载…'
          : (sceneDiagnostics?.loadingSlow ? 'Scene 加载较慢，请查看诊断' : '正在加载 Scene 场景…');
      } else if (playbackStatus && sceneStatus?.state === 'error') {
        return;
      } else if (playbackStatus && cfg.mode === 'video-blob' && !window.__codexWallpaperBlobUrl) {
        const transfer = window.__codexWallpaperVideoChunks;
        playbackStatus.textContent = transfer
          ? '正在加载原视频 ' + Math.min(100, Math.round(transfer.received / transfer.totalBytes * 100)) + '%'
          : '等待加载原视频…';
      } else if (playbackStatus && codexInactive()) {
        playbackStatus.textContent = '已暂停（Codex 未激活）';
      } else if (playbackStatus && media instanceof HTMLVideoElement && (cfg.mode !== 'video-blob' || window.__codexWallpaperBlobUrl)) {
        playbackStatus.textContent = '原视频播放中 · 离开 Codex 自动暂停';
      } else if (playbackStatus && cfg.mode === 'frames') {
        playbackStatus.textContent = '预览动画播放中 · 离开 Codex 自动暂停';
      } else if (playbackStatus && cfg.mode === 'scene') {
        playbackStatus.textContent = sceneDiagnostics?.stalled ? 'Scene 渲染停滞，请查看诊断'
          : 'Scene 实时渲染中' + (Number.isFinite(sceneDiagnostics?.fps) ? ' · ' + sceneDiagnostics.fps + ' FPS' : '');
      } else if (playbackStatus && cfg.mode === 'picker') {
        playbackStatus.textContent = cfg.sourceOptions.length ? '未选择壁纸' : '未发现可用的本地壁纸';
      }
    };
    const playbackChanged = () => syncPlayback();
    const playbackEvents = [['visibilitychange', playbackChanged, document], ['focusin', playbackChanged, document],
      ['pageshow', playbackChanged, window], ['focus', playbackChanged, window], ['blur', playbackChanged, window]];
    playbackEvents.forEach(([name, handler, target]) => target.addEventListener(name, handler));
    window.__codexWallpaperPauseCleanup = () => playbackEvents.forEach(([name, handler, target]) => target.removeEventListener(name, handler));
    window.__codexWallpaperSyncPlayback = syncPlayback;
    window.__codexWallpaperBeginVideo = (token, totalBytes, instanceId, mime = 'video/mp4', resume = false) => {
      if (instanceId !== cfg.instanceId) return false;
      const transfer = window.__codexWallpaperVideoChunks;
      if (resume && transfer?.totalBytes === totalBytes && transfer.mime === mime) {
        transfer.token = token;
        return true;
      }
      if (window.__codexWallpaperBlobUrl) URL.revokeObjectURL(window.__codexWallpaperBlobUrl);
      window.__codexWallpaperBlobUrl = null;
      finishedVideoToken = null;
      window.__codexWallpaperVideoChunks = { token, totalBytes, mime, received: 0, chunks: [] };
      if (!selectionPending) {
        if (playbackStatus) playbackStatus.textContent = '正在加载原视频 0%';
        setLoadingProgress(0);
      }
      return true;
    };
    window.__codexWallpaperPushVideoChunk = (token, base64) => {
      const transfer = window.__codexWallpaperVideoChunks;
      if (!transfer || transfer.token !== token) return false;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      transfer.chunks.push(bytes);
      transfer.received += bytes.length;
      const percent = Math.min(100, Math.round(transfer.received / transfer.totalBytes * 100));
      if (!selectionPending) {
        if (playbackStatus) playbackStatus.textContent = '正在加载原视频 ' + percent + '%';
        setLoadingProgress(percent);
      }
      // Commit with the last chunk so a controller handoff cannot strand a full transfer.
      if (transfer.received === transfer.totalBytes) window.__codexWallpaperFinishVideo(token, transfer.mime);
      return true;
    };
    window.__codexWallpaperFinishVideo = (token, mime) => {
      const transfer = window.__codexWallpaperVideoChunks;
      if (!transfer) return finishedVideoToken === token;
      if (transfer.token !== token || transfer.received !== transfer.totalBytes) return false;
      const blob = new Blob(transfer.chunks, { type: mime });
      window.__codexWallpaperVideoChunks = null;
      finishedVideoToken = token;
      window.__codexWallpaperBlobUrl = URL.createObjectURL(blob);
      media.src = window.__codexWallpaperBlobUrl;
      syncPlayback();
      if (!selectionPending) setLoadingProgress(100, 'done');
      return true;
    };
    window.__codexWallpaperVideoError = message => {
      window.__codexWallpaperVideoChunks = null;
      selectionPending = false;
      window.__codexWallpaperRuntime.failed = true;
      revealNew();
      if (playbackStatus) playbackStatus.textContent = '视频加载失败：' + message;
      setLoadingProgress(100, 'error');
    };

    const style = document.createElement('style');
    style.id = id + '-style';
    style.textContent = [
      'html,body{background:transparent!important}',
      'body>#root{position:relative!important;z-index:1!important;background:transparent!important}',
      'main,aside,nav,header,[role="navigation"],[role="main"]{background-color:rgba(20,22,26,var(--codex-skin-panel-opacity))!important}',
      '[data-app-action-timeline-scroll] [data-thread-user-message-navigation-content] ~ .sticky.pointer-events-none > .bg-gradient-to-t.from-surface{background-image:none!important}',
      '[data-app-action-timeline-scroll] [data-thread-scroll-footer] > div.pointer-events-none.absolute.bg-surface{background-color:transparent!important}',
      '[data-radix-popper-content-wrapper],[role="dialog"],[role="menu"],[role="listbox"]{background-color:rgba(20,22,26,.94)!important}',
      '@keyframes codex-skin-progress-indeterminate{0%{transform:translateX(-140%)}100%{transform:translateX(360%)}}'
    ].join('\\n');
    if (cfg.mode !== 'picker') document.head.appendChild(style);
    if (outgoing) document.body.insertBefore(layer, outgoing.nextSibling);
    else document.body.prepend(layer);
    if (cfg.mode !== 'picker') document.body.insertBefore(blurLayer, layer.nextSibling);
    else {
      layer.style.display = 'none';
      window.__codexWallpaperControlsOpen = true;
      window.__codexWallpaperPanelTab = 'library';
    }

    if (cfg.showControls && location.protocol === 'app:' && !location.search.includes('avatar-overlay')) {
      const controls = document.createElement('div');
      controls.id = id + '-controls';
      Object.assign(controls.style, {
        position: 'fixed', right: '18px', bottom: '88px', zIndex: '2147483647',
        width: '320px', maxWidth: 'calc(100vw - 24px)', color: '#fff', font: '12px system-ui', pointerEvents: 'auto'
      });
      const toggle = document.createElement('button');
      toggle.textContent = '皮肤调整';
      Object.assign(toggle.style, {
        float: 'right', border: '1px solid rgba(255,255,255,.18)', borderRadius: '6px',
        padding: '7px 11px', color: '#fff', background: 'rgba(15,17,21,.88)', cursor: 'pointer'
      });
      const panel = document.createElement('div');
      controlsPanel = panel;
      Object.assign(panel.style, {
        display: window.__codexWallpaperControlsOpen ? 'block' : 'none', clear: 'both', marginTop: '40px', padding: '12px', borderRadius: '8px',
        border: '1px solid rgba(255,255,255,.16)', background: 'rgba(15,17,21,.94)',
        boxShadow: '0 12px 40px rgba(0,0,0,.4)', backdropFilter: 'blur(18px)',
        maxHeight: 'calc(100vh - 170px)', overflowY: 'auto'
      });
      const title = document.createElement('div');
      title.textContent = 'Wallpaper Engine 皮肤';
      Object.assign(title.style, { fontWeight: '650', fontSize: '13px', marginBottom: '10px' });
      panel.appendChild(title);
      if (cfg.sourceOptions.length) {
        const sourceRow = document.createElement('label');
        sourceRow.style.cssText = 'display:grid;grid-template-columns:76px 1fr;align-items:center;gap:7px;margin:7px 0';
        const sourceLabel = document.createElement('span'); sourceLabel.textContent = '壁纸';
        const source = document.createElement('select');
        source.style.cssText = 'min-width:0;background:#24272d;color:#fff;border:1px solid #4a4f58;border-radius:6px;padding:4px';
        if (cfg.mode === 'picker') {
          const placeholder = document.createElement('option');
          placeholder.value = ''; placeholder.textContent = '选择壁纸'; placeholder.selected = true; placeholder.disabled = true;
          source.appendChild(placeholder);
        }
        cfg.sourceOptions.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; option.selected = item.id === cfg.currentId; source.appendChild(option); });
        source.addEventListener('change', () => requestSelection(source.value));
        sourceRow.append(sourceLabel, source); panel.appendChild(sourceRow);
      }
      playbackStatus = document.createElement('div');
      playbackStatus.setAttribute('data-skin-status', '');
      playbackStatus.textContent = cfg.mode === 'video-blob' ? '等待加载原视频…' : (cfg.mode === 'video' ? '原视频播放中 · 离开 Codex 自动暂停' : '预览动画模式 · 离开 Codex 自动暂停');
      playbackStatus.style.cssText = 'margin:6px 0 10px;color:#aeb7c6;overflow-wrap:anywhere';
      panel.appendChild(playbackStatus);
      playbackProgressTrack = document.createElement('div');
      playbackProgressTrack.setAttribute('role', 'progressbar');
      playbackProgressTrack.setAttribute('aria-label', '视频加载进度');
      playbackProgressTrack.style.cssText = 'height:5px;margin:-4px 0 11px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.12)';
      playbackProgressFill = document.createElement('div');
      playbackProgressFill.style.cssText = 'height:100%;width:0;border-radius:inherit;background:#4aa3ff;transition:width .16s ease';
      playbackProgressTrack.appendChild(playbackProgressFill);
      panel.appendChild(playbackProgressTrack);
      if (cfg.mode === 'video-blob') setLoadingProgress(0); else playbackProgressTrack.style.display = 'none';
      if (sceneStatus) {
        const diagnostics = document.createElement('details');
        diagnostics.style.cssText = 'margin:8px 0';
        const summary = document.createElement('summary'); summary.textContent = 'Scene 诊断';
        sceneDiagnosticText = document.createElement('pre');
        sceneDiagnosticText.style.cssText = 'font:11px monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto';
        diagnostics.append(summary, sceneDiagnosticText);
        panel.appendChild(diagnostics);
        renderSceneDiagnostics();
      }
      const addRange = (label, min, max, step, value, onInput) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:grid;grid-template-columns:76px 1fr 38px;align-items:center;gap:7px;margin:7px 0';
        const name = document.createElement('span'); name.textContent = label;
        const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
        input.style.cssText = 'min-width:0;width:100%;margin:0';
        const output = document.createElement('span'); output.textContent = value; output.style.textAlign = 'right';
        input.addEventListener('input', () => { output.textContent = input.value; onInput(Number(input.value)); });
        row.append(name, input, output); panel.appendChild(row);
      };
      const fitRow = document.createElement('label');
      fitRow.style.cssText = 'display:grid;grid-template-columns:76px 1fr;align-items:center;gap:7px;margin:7px 0';
      const fitLabel = document.createElement('span'); fitLabel.textContent = '适配';
      const fit = document.createElement('select');
      fit.style.cssText = 'background:#24272d;color:#fff;border:1px solid #4a4f58;border-radius:6px;padding:4px';
      [['cover','铺满裁切'],['contain','完整显示'],['fill','拉伸铺满']].forEach(([value,text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === cfg.fitMode; fit.appendChild(option); });
      fit.addEventListener('change', () => { cfg.fitMode = fit.value; media.style.objectFit = fit.value; if (cfg.mode === 'scene') syncPlayback(); persistSettings(); });
      fitRow.append(fitLabel, fit); panel.appendChild(fitRow);
      addRange('缩放 %', 50, 200, 1, cfg.zoom, value => { cfg.zoom = value; media.style.transform = 'scale(' + (value / 100) + ')'; persistSettings(); });
      let x = cfg.positionX, y = cfg.positionY;
      const applyPosition = () => { media.style.objectPosition = x + '% ' + y + '%'; };
      addRange('水平位置', 0, 100, 1, x, value => { x = value; cfg.positionX = value; applyPosition(); persistSettings(); });
      addRange('垂直位置', 0, 100, 1, y, value => { y = value; cfg.positionY = value; applyPosition(); persistSettings(); });
      addRange('面板透明', 10, 100, 1, Math.round(cfg.panelOpacity * 100), value => { cfg.panelOpacity = value / 100; rootStyle.setProperty('--codex-skin-panel-opacity', cfg.panelOpacity); persistSettings(); });
      addRange('背景遮罩', 0, 80, 1, Math.round(cfg.scrimOpacity * 100), value => { cfg.scrimOpacity = value / 100; scrim.style.background = 'rgba(0,0,0,' + cfg.scrimOpacity + ')'; persistSettings(); });
      addRange('背景模糊', 0, 40, 1, cfg.blurPx, value => {
        cfg.blurPx = value;
        rootStyle.setProperty('--codex-skin-blur', value + 'px');
        blurLayer.style.backdropFilter = 'blur(' + value + 'px) saturate(1.12)';
        persistSettings();
      });
      if (['scene', 'video', 'video-blob'].includes(cfg.mode)) {
        const soundRow = document.createElement('label');
        soundRow.style.cssText = 'display:grid;grid-template-columns:76px 1fr;align-items:center;gap:7px;margin:7px 0';
        const soundLabel = document.createElement('span'); soundLabel.textContent = '静音';
        const sound = document.createElement('input'); sound.type = 'checkbox'; sound.checked = cfg.muted;
        sound.setAttribute('aria-label', '壁纸静音');
        sound.style.cssText = 'justify-self:start;accent-color:#4aa3ff';
        sound.addEventListener('change', () => { cfg.muted = sound.checked; syncPlayback(); persistSettings(); });
        soundRow.append(soundLabel, sound); panel.appendChild(soundRow);
        addRange('音量 %', 0, 100, 1, Math.round(cfg.volume * 100), value => {
          cfg.volume = value / 100;
          syncPlayback();
          persistSettings();
        });
      }
      if (cfg.mode === 'scene' && Array.isArray(cfg.userProperties) && cfg.userProperties.length) {
        const heading = document.createElement('div');
        heading.textContent = '壁纸属性';
        heading.style.cssText = 'margin:12px 0 5px;font-weight:650;color:#dce5f2';
        panel.appendChild(heading);
        cfg.userPropertyValues = { ...(cfg.userPropertyValues || {}) };
        const sendUserProperties = () => {
          syncPlayback();
          persistSettings();
        };
        const propertyLabel = property => {
          if (!property.label.includes('<')) return property.label;
          const template = document.createElement('template');
          template.innerHTML = property.label;
          return template.content?.textContent.trim() || property.key;
        };
        const colorToHex = value => {
          if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value;
          const parts = Array.isArray(value) ? value : String(value ?? '').trim().split(/[\s,]+/);
          if (parts.length < 3) return '#ffffff';
          const rgb = parts.slice(0, 3).map(part => {
            const number = Number(part);
            return Math.round(Math.max(0, Math.min(1, Number.isFinite(number) ? number : 1)) * 255);
          });
          return '#' + rgb.map(part => part.toString(16).padStart(2, '0')).join('');
        };
        const colorFromHex = (hex, original) => {
          const values = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
          if (Array.isArray(original)) return [...values, ...original.slice(3)];
          const colorParts = typeof original === 'string'
            ? original.trim().replaceAll(',', ' ').split(' ').filter(Boolean)
            : null;
          if (colorParts?.length >= 3 && colorParts.every(part => Number.isFinite(Number(part)))) {
            return [...values.map(value => Number(value.toFixed(4))), ...colorParts.slice(3)].join(' ');
          }
          return hex;
        };
        const addPropertyRow = (property, input, onChange) => {
          input.setAttribute('data-user-property', property.key);
          const row = document.createElement('label');
          row.style.cssText = 'display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:7px;margin:7px 0';
          const label = document.createElement('span');
          label.textContent = propertyLabel(property);
          label.title = label.textContent;
          label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          input.style.cssText = 'box-sizing:border-box;min-width:0;width:100%;margin:0;background:#24272d;color:#fff;border:1px solid #4a4f58;border-radius:4px;padding:4px';
          if (input.type === 'checkbox') input.style.cssText = 'width:18px;height:18px;margin:0;justify-self:start;accent-color:#64c8ba';
          if (input.type === 'color') input.style.height = '28px';
          input.addEventListener('change', onChange);
          row.append(label, input);
          panel.appendChild(row);
        };
        for (const property of cfg.userProperties) {
          const value = Object.hasOwn(cfg.userPropertyValues, property.key) ? cfg.userPropertyValues[property.key] : property.value;
          cfg.userPropertyValues[property.key] = value;
          if (property.type === 'bool') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = value === true;
            input.setAttribute('aria-label', propertyLabel(property));
            input.style.justifySelf = 'start';
            addPropertyRow(property, input, () => {
              cfg.userPropertyValues[property.key] = input.checked;
              sendUserProperties();
            });
          } else if (property.type === 'slider') {
            const row = document.createElement('label');
            row.style.cssText = 'display:grid;grid-template-columns:76px minmax(0,1fr) 42px;align-items:center;gap:7px;margin:7px 0';
            const label = document.createElement('span');
            label.textContent = propertyLabel(property);
            label.title = label.textContent;
            label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            const input = document.createElement('input');
            input.type = 'range';
            input.setAttribute('data-user-property', property.key);
            input.min = property.min;
            input.max = property.max;
            input.step = property.step;
            input.value = value;
            input.style.cssText = 'min-width:0;width:100%;margin:0';
            const output = document.createElement('span');
            output.textContent = input.value;
            output.style.textAlign = 'right';
            input.addEventListener('input', () => {
              output.textContent = input.value;
              cfg.userPropertyValues[property.key] = Number(input.value);
              sendUserProperties();
            });
            row.append(label, input, output);
            panel.appendChild(row);
          } else if (property.type === 'color') {
            const input = document.createElement('input');
            input.type = 'color';
            input.value = colorToHex(value);
            input.setAttribute('aria-label', propertyLabel(property));
            addPropertyRow(property, input, () => {
              cfg.userPropertyValues[property.key] = colorFromHex(input.value, cfg.userPropertyValues[property.key]);
              sendUserProperties();
            });
          } else if (property.type === 'combo') {
            const input = document.createElement('select');
            for (const optionData of property.options || []) {
              const option = document.createElement('option');
              option.value = JSON.stringify(optionData.value);
              option.textContent = optionData.label;
              option.selected = Object.is(optionData.value, value);
              input.appendChild(option);
            }
            addPropertyRow(property, input, () => {
              try { cfg.userPropertyValues[property.key] = JSON.parse(input.value); } catch { /* keep current value */ }
              sendUserProperties();
            });
          } else {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = String(value ?? '');
            input.setAttribute('aria-label', propertyLabel(property));
            addPropertyRow(property, input, () => {
              cfg.userPropertyValues[property.key] = input.value.slice(0, 2048);
              sendUserProperties();
            });
          }
        }
      }
      toggle.addEventListener('click', () => {
        window.__codexWallpaperControlsOpen = panel.style.display === 'none';
        panel.style.display = window.__codexWallpaperControlsOpen ? 'block' : 'none';
      });
      controls.append(toggle, panel);
      document.body.appendChild(controls);
      window.__codexWallpaperRopeCleanup = installRope({ controls, toggle, panel, imageUrl: ropeImageUrl });
    }
    const snapshot = () => ({
      installed: true, instanceId: cfg.instanceId, mode: cfg.mode, url: location.href,
      controls: !!document.getElementById(id + '-controls'),
      videoLoading: cfg.mode === 'video-blob' && !window.__codexWallpaperBlobUrl,
      videoTransferActive: !!window.__codexWallpaperVideoChunks,
      sceneLoading: sceneStatus?.state === 'loading',
      sceneError: sceneStatus?.error || null,
      sceneDiagnostics,
      settings: {
        panelOpacity: cfg.panelOpacity, scrimOpacity: cfg.scrimOpacity, blurPx: cfg.blurPx,
        muted: cfg.muted, volume: cfg.volume, fitMode: cfg.fitMode, zoom: cfg.zoom, positionX: cfg.positionX,
        positionY: cfg.positionY, showControls: cfg.showControls, userPropertyValues: cfg.userPropertyValues,
        rotation: cfg.rotation, mouseEnabled: cfg.mouseEnabled
      }
    });
    window.__codexWallpaperRuntime = {
      config: cfg, restoreVersion: 4, sceneDiagnosticsVersion: 1, sourceMode: cfg.mode, controllers, layer, sceneStatus, getMedia: () => media, snapshot,
      suspend() {
        if (media instanceof HTMLVideoElement) { media.muted = true; media.pause(); }
        if (cfg.mode === 'scene' && sceneStatus.state === 'ready') {
          media.contentWindow?.postMessage({ type: 'codex-scene-playback', paused: true, muted: true, volume: 0 }, sceneOrigin);
        }
      }
    };
    window.__codexWallpaperReleaseController = controllerId => {
      const runtime = window.__codexWallpaperRuntime;
      if (!runtime) return false;
      runtime.controllers = runtime.controllers.filter(value => value !== controllerId);
      if (runtime.config.controllerId === controllerId) runtime.config.controllerId = runtime.controllers.at(-1) || null;
      return true;
    };
    if (sceneStatus) setLoadingProgress(null);
    window.__codexWallpaperFeaturesCleanup = (${installSkinFeatures.toString()})({
      cfg, panel: controlsPanel, requestSelection, persistSettings, getMedia: () => media, sceneOrigin,
      isBusy: () => selectionPending || window.__codexWallpaperRuntime.failed
        || (cfg.mode === 'scene' && sceneStatus.state !== 'ready')
        || (cfg.mode === 'video-blob' && !window.__codexWallpaperBlobUrl)
        || (media instanceof HTMLVideoElement && media.readyState < 2)
    });
    if (media instanceof HTMLVideoElement) media.addEventListener('loadeddata', revealNew, { once: true });
    else if (cfg.mode === 'preview') media.addEventListener('load', revealNew, { once: true });
    if (media.complete || media.readyState >= 2) revealNew();
    syncPlayback();
    ${makeSidebarUpgradeScript(controllerId)};
    return { ...snapshot(), reused: false };
  })()`;
}

const REMOVE_SCRIPT = `(() => {
  const id = ${JSON.stringify(LAYER_ID)};
  window.__codexWallpaperFeaturesCleanup?.();
  window.__codexWallpaperSidebarWatchCleanup?.();
  window.__codexWallpaperSidebarWatchCleanup = null;
  window.__codexWallpaperEnsureSidebar = null;
  window.__codexWallpaperSidebarCleanup?.();
  window.__codexWallpaperSidebarCleanup = null;
  window.__codexWallpaperFeaturesCleanup = null;
  window.__codexWallpaperRopeCleanup?.();
  window.__codexWallpaperRopeCleanup = null;
  window.__codexWallpaperTransitionCleanup?.();
  window.__codexWallpaperRuntime = null;
  window.__codexWallpaperReleaseController = null;
  document.getElementById(id)?.remove();
  document.getElementById(id + '-blur')?.remove();
  document.getElementById(id + '-style')?.remove();
  document.getElementById(id + '-controls')?.remove();
  window.__codexWallpaperPauseCleanup?.();
  window.__codexWallpaperPauseCleanup = null;
  window.__codexWallpaperSyncPlayback = null;
  window.__codexWallpaperSceneMessageCleanup?.();
  window.__codexWallpaperSceneMessageCleanup = null;
  document.documentElement.style.removeProperty('--codex-skin-panel-opacity');
  document.documentElement.style.removeProperty('--codex-skin-blur');
  if (window.__codexWallpaperFrameTimer) cancelAnimationFrame(window.__codexWallpaperFrameTimer);
  window.__codexWallpaperFrameTimer = null;
  window.__codexWallpaperFrameCache = null;
  if (window.__codexWallpaperBlobUrl) URL.revokeObjectURL(window.__codexWallpaperBlobUrl);
  window.__codexWallpaperBlobUrl = null;
  window.__codexWallpaperVideoChunks = null;
  return { removed: true, url: location.href };
})()`;

async function discoverTargets(port) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2500) });
  } catch {
    response = await fetch(`http://[::1]:${port}/json`, { signal: AbortSignal.timeout(2500) });
  }
  if (!response.ok) throw new Error(`Codex debug endpoint returned HTTP ${response.status}.`);
  const targets = await response.json();
  return targets.filter(isCodexTarget);
}

export async function prepareCodexScenePage(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Scene initialization requires the actual loopback debug port.');
  }
  const targets = await discoverTargets(port);
  if (!targets.length) throw new Error('No exact Codex main page is available for Scene initialization.');
  const prepared = [];
  for (const target of targets) {
    const client = new CdpClient(target.webSocketDebuggerUrl);
    let timeout;
    try {
      await client.connect();
      await client.call('Page.enable');
      await client.call('Page.setBypassCSP', { enabled: true });
      const token = randomUUID();
      const script = await client.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__codexWallpaperScenePrepared = ${JSON.stringify(token)};`,
      });
      const loaded = new Promise((resolvePromise, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex Scene page initialization did not finish within 20 seconds.')), 20000);
        client.onEvent = message => {
          if (message.method === 'Page.loadEventFired') resolvePromise();
        };
      });
      // frame-src permission is fixed when a document initializes, not by late injection.
      await Promise.all([client.call('Page.reload'), loaded]);
      const result = await client.call('Runtime.evaluate', {
        expression: `({url:location.href,ready:document.readyState==='complete',prepared:window.__codexWallpaperScenePrepared===${JSON.stringify(token)}})`,
        returnByValue: true,
      });
      const value = result.result?.value;
      if (result.exceptionDetails || value?.url !== 'app://-/index.html' || !value.ready || !value.prepared) {
        throw new Error('Codex did not complete the expected Scene initialization document.');
      }
      await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
      prepared.push({ id: target.id, url: value.url });
    } finally {
      clearTimeout(timeout);
      client.close();
    }
  }
  return { prepared: true, targetCount: prepared.length, targets: prepared };
}

export function isCodexTarget(target) {
  return target?.type === 'page'
    && Boolean(target.webSocketDebuggerUrl)
    && target.url === 'app://-/index.html';
}

export function buildNativeThemeString({ variant = 'dark', accent = '#339CFF', surface = '#181818', ink = '#FFFFFF', contrast = 60, codeThemeId = 'codex', uiFont = null, codeFont = null, translucent = true }) {
  const hex = /^#[0-9A-Fa-f]{6}$/;
  for (const [name, value] of Object.entries({ accent, surface, ink })) {
    if (!hex.test(value)) throw new Error(`${name} must be a six-digit hex color.`);
  }
  if (!['light', 'dark'].includes(variant)) throw new Error('variant must be light or dark.');
  const payload = {
    codeThemeId,
    theme: {
      accent,
      contrast: Math.max(0, Math.min(100, Math.round(contrast))),
      fonts: { code: codeFont || null, ui: uiFont || null },
      ink,
      opaqueWindows: !translucent,
      semanticColors: { diffAdded: '#40C977', diffRemoved: '#FA423E', skill: '#AD7BF9' },
      surface,
    },
    variant,
  };
  return `codex-theme-v1:${JSON.stringify(payload)}`;
}

export class CodexSkinBridge {
  constructor({ cdpPort = DEFAULT_CDP_PORT, stateFile = DEFAULT_STATE_FILE, debugEndpointFile = DEFAULT_DEBUG_ENDPOINT_FILE, restoreIntervalMs = 3000 } = {}) {
    this.cdpPort = cdpPort;
    this.debugEndpointFile = debugEndpointFile;
    this.stateFile = stateFile;
    this.clients = new Map();
    this.controllerId = randomUUID();
    this.active = null;
    this.watchdog = null;
    this.streamGeneration = 0;
    this.sceneRuntime = new SceneRuntimeServer();
    this.selectionTask = Promise.resolve();
    this.saved = readSavedSkinState(this.stateFile);
    this.restoreInFlight = false;
    this.lastRestoreError = null;
    this.restoreWatchdog = null;
    if (restoreIntervalMs > 0) {
      this.restoreWatchdog = setInterval(() => this.restoreSaved().catch(() => {}), restoreIntervalMs);
      this.restoreWatchdog.unref();
      setTimeout(() => this.restoreSaved().catch(() => {}), 0).unref();
    }
  }

  savedSettings() {
    return this.active && this.active.mode !== 'picker' ? {
      id: this.active.currentId,
      panelOpacity: this.active.panelOpacity,
      scrimOpacity: this.active.scrimOpacity,
      blurPx: this.active.blurPx,
      muted: this.active.muted,
      volume: this.active.volume,
      fitMode: this.active.fitMode,
      zoom: this.active.zoom,
      positionX: this.active.positionX,
      positionY: this.active.positionY,
      showControls: this.active.showControls,
      userPropertyValues: this.active.userPropertyValues,
      rotation: this.active.rotation,
      mouseEnabled: this.active.mouseEnabled,
    } : null;
  }

  persistActive() {
    const settings = this.savedSettings();
    if (!settings) return;
    const persisted = readSavedSkinState(this.stateFile);
    const projectProperties = { ...(this.saved?.projectProperties || {}), ...(persisted?.projectProperties || {}) };
    if (settings.userPropertyValues) projectProperties[settings.id] = settings.userPropertyValues;
    this.saved = { enabled: true, ...settings, projectProperties, updatedAt: new Date().toISOString() };
    writeSavedSkinState(this.saved, this.stateFile);
  }

  async restoreSaved() {
    if (this.active || !this.saved || this.restoreInFlight) return false;
    this.restoreInFlight = true;
    try {
      const debug = await this.debugStatus();
      if (!debug.available) return false;
      await this.apply(this.saved, { reuseExisting: true });
      this.lastRestoreError = null;
      return true;
    } catch (error) {
      this.lastRestoreError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.restoreInFlight = false;
    }
  }

  async showPicker() {
    this.saved = readSavedSkinState(this.stateFile);
    if (this.saved) return this.restoreSaved();
    const projects = enumerateWallpaperSources().filter(project => project.skinMode !== 'unsupported');
    this.active = { mode: 'picker', currentId: null, instanceId: randomUUID(),
      sourceOptions: await this.sceneRuntime.librarySources(projects) };
    try { return await this.injectCurrent(); }
    catch (error) { this.active = null; throw error; }
  }

  async debugStatus() {
    let port = this.cdpPort || null;
    try {
      port = resolveDebugPort(this.cdpPort, this.debugEndpointFile);
      const targets = await discoverTargets(port);
      return { available: targets.length > 0, port, targetCount: targets.length };
    } catch (error) {
      return { available: false, port, targetCount: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureClients() {
    const targets = await discoverTargets(resolveDebugPort(this.cdpPort, this.debugEndpointFile));
    const liveTargets = new Map(targets.map(target => [target.id, target.webSocketDebuggerUrl]));
    for (const [id, client] of this.clients) {
      if (liveTargets.get(id) !== client.url || client.socket?.readyState !== WebSocket.OPEN) {
        client.close();
        this.clients.delete(id);
      }
    }
    const added = [];
    for (const target of targets) {
      if (this.clients.has(target.id)) continue;
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.call('Page.enable');
      await client.call('Runtime.enable');
      await client.call('Runtime.addBinding', { name: 'codexSkinCommand' });
      await client.call('Page.setBypassCSP', { enabled: true });
      client.onEvent = (message) => this.handleClientEvent(message, client);
      this.clients.set(target.id, client);
      added.push(client);
    }
    return { targetCount: targets.length, added };
  }

  async restoreClient(client) {
    if (!this.active || !client) return;
    const evaluated = await client.call('Runtime.evaluate', {
      expression: `(() => {
        if (location.href !== 'app://-/index.html') return null;
        const runtime = window.__codexWallpaperRuntime;
        if (runtime?.config.controllerId !== ${JSON.stringify(this.controllerId)}) return null;
        return { ...runtime.snapshot(), currentId: runtime.config.currentId };
      })()`,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
    const state = evaluated.result?.value;
    if (this.active.mode === 'picker') {
      const persisted = readSavedSkinState(this.stateFile);
      if (persisted) await this.apply(persisted, { reuseExisting: true });
      return;
    }
    if (state?.settings) {
      // New-document scripts capture old values; the elected owner must read shared disk state.
      const persisted = this.stateFile ? readSavedSkinState(this.stateFile) : null;
      const settings = persisted || this.savedSettings();
      const changed = state.currentId !== settings.id || Object.keys(this.savedSettings()).some(key =>
        key !== 'id' && settings[key] !== undefined && JSON.stringify(settings[key]) !== JSON.stringify(state.settings[key]));
      if (changed || this.active.currentId !== settings.id) {
        if (persisted) await this.apply(settings, { reuseExisting: !changed });
        else await this.injectCurrent({ reuseExisting: false });
        return;
      }
      Object.assign(this.active, state.settings);
    }
    if (state?.videoLoading && !state.videoTransferActive && this.active.mode === 'video-blob') {
      client.skinInstanceId = state.instanceId;
      await this.streamVideoToClients(this.active.videoPath, this.active.videoBytes, this.streamGeneration, [client]);
    }
  }

  handleClientEvent(message, client) {
    if (message.method === 'Page.loadEventFired') {
      return this.restoreClient(client).catch(error => this.reportVideoError(error, [client]));
    }
    if (message.method !== 'Runtime.bindingCalled' || message.params?.name !== 'codexSkinCommand') return;
    let command;
    try { command = JSON.parse(message.params.payload); } catch { return; }
    const selectionRequest = command?.action === 'select-request' && typeof command.requestId === 'string';
    if (!selectionRequest && command?.controllerId !== this.controllerId) return;
    if (command?.action === 'settings' && this.active && command.settings && typeof command.settings === 'object') {
      if (typeof command.currentId === 'string' && command.currentId !== this.active.currentId) return;
      const settings = command.settings;
      if (Number.isFinite(settings.panelOpacity)) this.active.panelOpacity = Math.max(0.1, Math.min(1, settings.panelOpacity));
      if (Number.isFinite(settings.scrimOpacity)) this.active.scrimOpacity = Math.max(0, Math.min(0.8, settings.scrimOpacity));
      if (Number.isFinite(settings.blurPx)) this.active.blurPx = Math.max(0, Math.min(40, Math.round(settings.blurPx)));
      if (typeof settings.muted === 'boolean') this.active.muted = settings.muted;
      if (Number.isFinite(settings.volume)) this.active.volume = Math.max(0, Math.min(1, settings.volume));
      if (['cover', 'contain', 'fill'].includes(settings.fitMode)) this.active.fitMode = settings.fitMode;
      if (Number.isFinite(settings.zoom)) this.active.zoom = Math.max(50, Math.min(400, Math.round(settings.zoom)));
      if (Number.isFinite(settings.positionX)) this.active.positionX = Math.max(0, Math.min(100, Math.round(settings.positionX)));
      if (Number.isFinite(settings.positionY)) this.active.positionY = Math.max(0, Math.min(100, Math.round(settings.positionY)));
      if (settings.userPropertyValues && typeof settings.userPropertyValues === 'object') {
        this.active.userPropertyValues = resolveUserPropertyValues(this.active.userProperties, settings.userPropertyValues);
      }
      if (settings.rotation && typeof settings.rotation === 'object') {
        this.active.rotation = normalizeRotation(settings.rotation, this.active.sourceOptions);
      }
      if (typeof settings.mouseEnabled === 'boolean') this.active.mouseEnabled = settings.mouseEnabled;
      this.persistActive();
      return;
    }
    if (command?.action === 'refresh-sources' && this.active) {
      return this.refreshSources();
    }
    if (command?.action === 'preview-thumbnail') return this.replyThumbnail(command, client);
    if ((!selectionRequest && command?.action !== 'select') || typeof command.id !== 'string') return;
    const previous = this.active;
    const settings = command.settings && typeof command.settings === 'object' ? command.settings : previous ? {
      panelOpacity: previous.panelOpacity, scrimOpacity: previous.scrimOpacity,
      blurPx: previous.blurPx, muted: previous.muted, volume: previous.volume, fitMode: previous.fitMode,
      zoom: previous.zoom, positionX: previous.positionX, positionY: previous.positionY,
      showControls: previous.showControls,
      userPropertyValues: previous.userPropertyValues,
      rotation: previous.rotation,
      mouseEnabled: previous.mouseEnabled,
    } : {};
    this.selectionTask = this.selectionTask
      .catch(() => {})
      .then(async () => {
        if (selectionRequest) {
          if (!client) return;
          // Bindings fan out to live sessions; the renderer elects exactly one claimant.
          const claimed = await client.call('Runtime.evaluate', {
            expression: `(() => {
              if (location.href !== 'app://-/index.html') return false;
              const runtime = window.__codexWallpaperRuntime;
              const request = window.__codexWallpaperSelectionRequest;
              if (!runtime || request?.requestId !== ${JSON.stringify(command.requestId)}
                  || request.id !== ${JSON.stringify(command.id)} || request.claimedBy) return false;
              request.claimedBy = ${JSON.stringify(this.controllerId)};
              runtime.config.controllerId = request.claimedBy;
              runtime.controllers = runtime.controllers.filter(id => id !== request.claimedBy);
              runtime.controllers.push(request.claimedBy);
              return true;
            })()`,
            returnByValue: true,
          });
          if (claimed.exceptionDetails) throw new Error(claimed.exceptionDetails.text);
          if (!claimed.result?.value) return;
        }
        const nextSettings = { ...settings };
        if (command.id !== (command.currentId ?? previous?.currentId)) delete nextSettings.userPropertyValues;
        return this.apply({ id: command.id, ...nextSettings },
          selectionRequest ? { selectionRequestId: command.requestId } : undefined);
      })
      .catch((error) => this.reportVideoError(error));
  }

  async replyThumbnail(command, client) {
    const active = this.active;
    if (!active || !client || command.instanceId !== active.instanceId
        || typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 160) return;
    const source = active.sourceOptions?.find(item => item.id === command.id && item.thumbnailUrl === command.url);
    if (!source?.thumbnailUrl) return;
    const result = { requestId: command.requestId, id: source.id, url: source.thumbnailUrl };
    try {
      result.dataUrl = this.sceneRuntime.readLibraryPreview(source.id, source.thumbnailUrl);
    } catch (error) {
      result.error = String(error?.message || error).slice(0, 300);
    }
    if (this.active !== active) return;
    const evaluated = await client.call('Runtime.evaluate', {
      expression: `(() => {
        if (location.href !== 'app://-/index.html' || window !== window.top) return false;
        const runtime = window.__codexWallpaperRuntime;
        if (runtime?.config.controllerId !== ${JSON.stringify(this.controllerId)}
            || runtime.config.instanceId !== ${JSON.stringify(active.instanceId)}
            || !runtime.config.sourceOptions.some(item => item.id === ${JSON.stringify(source.id)}
              && item.thumbnailUrl === ${JSON.stringify(source.thumbnailUrl)})) return false;
        runtime.sidebar?.resolveThumbnail?.(${JSON.stringify(result)});
        return true;
      })()`,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  }

  async refreshSources() {
    if (this.sourceRefreshTask) return this.sourceRefreshTask;
    const active = this.active;
    if (!active) return;
    this.sourceRefreshTask = (async () => {
      let sources;
      let errorMessage = null;
      try {
        sources = await this.sceneRuntime.librarySources(enumerateWallpaperSources());
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      if (this.active !== active) return;
      if (sources) active.sourceOptions = sources;
      for (const client of this.clients.values()) {
        const evaluated = await client.call('Runtime.evaluate', {
          expression: `(() => {
            if (location.href !== 'app://-/index.html' || window !== window.top) return false;
            const runtime = window.__codexWallpaperRuntime;
            if (runtime?.config.controllerId !== ${JSON.stringify(this.controllerId)}
                || runtime.config.currentId !== ${JSON.stringify(active.currentId)}) return false;
            const sources = ${JSON.stringify(sources || null)};
            if (sources) runtime.config.sourceOptions = sources;
            runtime.sidebar?.refreshLibrary?.(${JSON.stringify(errorMessage)});
            return true;
          })()`,
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
      }
    })();
    try { return await this.sourceRefreshTask; }
    finally { this.sourceRefreshTask = null; }
  }

  async reportVideoError(error, clients = this.clients.values(), transfer = null) {
    const message = error instanceof Error ? error.message : String(error);
    const expression = `(() => {
      const expected = ${JSON.stringify(transfer)};
      if (expected && (window.__codexWallpaperRuntime?.config.instanceId !== expected.instanceId
          || window.__codexWallpaperVideoChunks?.token !== expected.token)) return false;
      window.__codexWallpaperVideoError?.(${JSON.stringify(message)});
      return true;
    })()`;
    for (const client of clients) {
      try { await client.call('Runtime.evaluate', { expression }); } catch { /* closed target */ }
    }
  }

  async streamVideoToClients(file, totalBytes, generation, clients = [...this.clients.values()]) {
    for (const client of clients) {
      const token = randomUUID();
      const instanceId = client.skinInstanceId;
      let descriptor;
      try {
        if (generation !== this.streamGeneration) return;
        const started = await client.call('Runtime.evaluate', {
          expression: `(() => {
            if (!window.__codexWallpaperBeginVideo?.(${JSON.stringify(token)},${totalBytes},${JSON.stringify(instanceId)},${JSON.stringify(mimeFor(file))},true)) return null;
            return window.__codexWallpaperVideoChunks.received;
          })()`, returnByValue: true,
        });
        if (started.exceptionDetails) throw new Error(started.exceptionDetails.text);
        let offset = started.result?.value;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) continue;
        descriptor = openSync(file, 'r');
        const buffer = Buffer.allocUnsafe(2 * 1024 * 1024);
        while (offset < totalBytes) {
          if (generation !== this.streamGeneration) return;
          const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, totalBytes - offset), offset);
          if (!count) throw new Error('Unexpected end of video file.');
          const base64 = buffer.subarray(0, count).toString('base64');
          const pushed = await client.call('Runtime.evaluate', {
            expression: `window.__codexWallpaperPushVideoChunk?.(${JSON.stringify(token)},${JSON.stringify(base64)})`,
            returnByValue: true,
          });
          if (pushed.exceptionDetails) throw new Error(pushed.exceptionDetails.text);
          if (pushed.result?.value !== true) break;
          offset += count;
        }
      } catch (error) {
        await this.reportVideoError(error, [client], { instanceId, token });
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
  }

  async injectCurrent({ onlyNew = false, reuseExisting = onlyNew, selectionRequestId = null } = {}) {
    const { targetCount, added } = await this.ensureClients();
    if (!targetCount) throw new Error('No Codex renderer targets were found on the debug port.');
    const config = { ...this.active, controllerId: this.controllerId };
    const source = makeInjectionScript({ ...config, reuseExisting: true });
    const restoreSource = `(() => {
      if (window !== window.top || location.href !== 'app://-/index.html') return;
      const install = () => ${source};
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
      } else install();
    })()`;
    const expression = makeInjectionScript({ ...config, reuseExisting, selectionRequestId });
    const results = [];
    const transferClients = [];
    const clients = onlyNew ? added : this.clients.values();
    for (const client of clients) {
      const evaluated = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
      const result = evaluated.result?.value || { installed: true };
      results.push(result);
      if (result.superseded) continue;
      if (client.scriptId) {
        try { await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId }); } catch { /* ignore */ }
      }
      const registered = await client.call('Page.addScriptToEvaluateOnNewDocument', { source: restoreSource });
      client.scriptId = registered.identifier;
      client.skinInstanceId = result.instanceId;
      if (result.reused) Object.assign(this.active, result.settings);
      if (!result.reused || result.videoLoading) transferClients.push(client);
    }
    if (this.active.mode === 'video-blob' && transferClients.length) {
      this.streamVideoToClients(this.active.videoPath, this.active.videoBytes, this.streamGeneration, transferClients)
        .catch(error => this.reportVideoError(error, transferClients));
    }
    return results;
  }

  async apply(options, { reuseExisting = false, selectionRequestId = null } = {}) {
    this.saved = readSavedSkinState(this.stateFile) || this.saved;
    const { id, userPropertyValues } = options;
    // Omitted adjustments inherit the latest shared state, not first-install defaults.
    const { panelOpacity, scrimOpacity, blurPx, muted, volume, fitMode, zoom, positionX, positionY,
      showControls, rotation, mouseEnabled } = {
      ...this.savedSettings(), ...this.saved,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    };
    const projects = enumerateWallpaperSources();
    const project = projects.find((item) => item.id === id);
    if (!project) throw new Error(`Unknown Wallpaper Engine source id: ${id}`);
    if (project.skinMode === 'unsupported') throw new Error('This project has no browser-portable media or preview image.');
    let selected = selectEmbeddableMedia(project);
    if (selected.mode === 'scene') {
      selected = { ...selected, ...(await this.sceneRuntime.prepare(project)) };
    }
    const sourceOptions = await this.sceneRuntime.librarySources(projects);
    const projectProperties = project.userProperties || [];
    const selectedPropertyValues = resolveUserPropertyValues(
      projectProperties,
      userPropertyValues ?? this.saved?.projectProperties?.[project.id]
        ?? (this.saved?.id === project.id ? this.saved.userPropertyValues : null),
    );
    const previous = this.active;
    this.active = {
      mediaUrl: selected.mediaUrl,
      mediaFrames: selected.mediaFrames || [],
      frameDelayMs: selected.frameDelayMs || 250,
      frameRate: selected.frameRate || null,
      mode: selected.mode,
      instanceId: randomUUID(),
      videoPath: selected.videoPath || null,
      videoBytes: selected.videoBytes || null,
      panelOpacity: Number.isFinite(panelOpacity) ? Math.max(0.1, Math.min(1, panelOpacity)) : 0.2,
      scrimOpacity: Number.isFinite(scrimOpacity) ? Math.max(0, Math.min(0.9, scrimOpacity)) : 0.1,
      blurPx: Number.isFinite(blurPx) ? Math.max(0, Math.min(60, Math.round(blurPx))) : 3,
      muted: muted !== false,
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.3,
      fitMode: ['cover', 'contain', 'fill'].includes(fitMode) ? fitMode : 'contain',
      zoom: Number.isFinite(zoom) ? Math.max(50, Math.min(400, Math.round(zoom))) : 100,
      positionX: Number.isFinite(positionX) ? Math.max(0, Math.min(100, Math.round(positionX))) : 50,
      positionY: Number.isFinite(positionY) ? Math.max(0, Math.min(100, Math.round(positionY))) : 50,
      showControls: showControls !== false,
      sourceOptions,
      rotation: normalizeRotation(rotation ?? this.active?.rotation ?? this.saved?.rotation, sourceOptions),
      mouseEnabled: typeof mouseEnabled === 'boolean' ? mouseEnabled : this.active?.mouseEnabled ?? this.saved?.mouseEnabled ?? false,
      currentId: project.id,
      sceneRendererUrl: selected.sceneRendererUrl || null,
      scenePageUrl: selected.scenePageUrl || null,
      sceneSourceUrl: selected.sceneSourceUrl || null,
      sceneProjectUrl: selected.sceneProjectUrl || null,
      userProperties: projectProperties,
      userPropertyValues: selectedPropertyValues,
    };
    ++this.streamGeneration;
    let targets;
    try {
      targets = await this.injectCurrent({ reuseExisting, selectionRequestId });
    } catch (error) {
      this.active = null;
      throw error;
    }
    if (targets.every(target => target.superseded)) {
      this.active = previous;
      return { applied: false, superseded: true };
    }
    this.persistActive();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.active) this.injectCurrent({ onlyNew: true }).catch(() => {});
      }, 5000);
      this.watchdog.unref();
    }
    return {
      applied: true,
      project: { id: project.id, title: project.title, type: project.type, skinMode: project.skinMode },
      renderMode: selected.mode,
      usedPreviewFallback: selected.fallback,
      fallbackKind: selected.fallbackKind,
      sourceResolution: selected.sourceResolution || null,
      renderResolution: selected.renderResolution || null,
      frameRate: selected.frameRate || null,
      videoLoading: targets.some(target => target.videoLoading),
      sceneLoading: targets.some(target => target.sceneLoading),
      videoBytes: selected.videoBytes || null,
      compressed: selected.compressed || false,
      originalBytes: selected.originalBytes || null,
      compressionRatio: selected.compressionRatio || null,
      bitrateKbps: selected.bitrateKbps || null,
      compressionCached: selected.compressionCached || false,
      hasAudio: selected.hasAudio ?? null,
      targetCount: targets.length,
      settings: {
        panelOpacity: this.active.panelOpacity, scrimOpacity: this.active.scrimOpacity,
        blurPx: this.active.blurPx, muted: this.active.muted, volume: this.active.volume, fitMode: this.active.fitMode,
        zoom: this.active.zoom, positionX: this.active.positionX, positionY: this.active.positionY,
        showControls: this.active.showControls, userPropertyValues: this.active.userPropertyValues,
        rotation: this.active.rotation, mouseEnabled: this.active.mouseEnabled,
      },
    };
  }

  async remove() {
    this.streamGeneration++;
    const removed = [];
    try { await this.ensureClients(); } catch { /* debug endpoint may already be gone */ }
    for (const client of this.clients.values()) {
      try {
        if (client.scriptId) await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId });
        const evaluated = await client.call('Runtime.evaluate', { expression: REMOVE_SCRIPT, returnByValue: true });
        removed.push(evaluated.result?.value || { removed: true });
      } catch { /* closed target */ }
      client.close();
    }
    this.clients.clear();
    this.active = null;
    this.saved = null;
    this.lastRestoreError = null;
    clearSavedSkinState(this.stateFile);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.sceneRuntime.close();
    return { removed: true, targetCount: removed.length };
  }

  disconnect() {
    this.streamGeneration++;
    const disconnects = [...this.clients.values()].map(async client => {
      try {
        if (client.scriptId) await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId });
        await client.call('Runtime.evaluate', {
          expression: `window.__codexWallpaperReleaseController?.(${JSON.stringify(this.controllerId)})`,
        });
      } catch { /* the renderer may already be closed */ }
      finally { client.close(); }
    });
    this.clients.clear();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.restoreWatchdog) clearInterval(this.restoreWatchdog);
    this.restoreWatchdog = null;
    return Promise.all([...disconnects, this.sceneRuntime.close()]);
  }

  async status() {
    const active = this.active ? {
      mode: this.active.mode,
      panelOpacity: this.active.panelOpacity,
      scrimOpacity: this.active.scrimOpacity,
      blurPx: this.active.blurPx,
      muted: this.active.muted,
      volume: this.active.volume,
      fitMode: this.active.fitMode,
      zoom: this.active.zoom,
      positionX: this.active.positionX,
      positionY: this.active.positionY,
      showControls: this.active.showControls,
      rotation: this.active.rotation,
      mouseEnabled: this.active.mouseEnabled,
    } : null;
    const renderers = await Promise.all([...this.clients].map(async ([targetId, client]) => {
      try {
        const evaluated = await client.call('Runtime.evaluate', {
          expression: `(() => {
            if (location.href !== 'app://-/index.html') return null;
            const runtime = window.__codexWallpaperRuntime;
            return runtime ? { ...runtime.snapshot(), currentId: runtime.config.currentId,
              failed: Boolean(runtime.failed), inactive: document.hidden || !document.hasFocus() } : null;
          })()`,
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
        return { targetId, available: Boolean(evaluated.result?.value), ...evaluated.result?.value };
      } catch (error) {
        return { targetId, available: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return {
      debug: await this.debugStatus(), active, connectedTargets: this.clients.size,
      renderers,
      persistence: {
        enabled: Boolean(this.saved),
        selectedId: this.saved?.id || null,
        autoRestorePending: Boolean(this.saved && !this.active),
        lastRestoreError: this.lastRestoreError,
      },
    };
  }
}
