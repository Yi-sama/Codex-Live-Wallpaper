export async function startScenePlayer(host = window, loadRenderer = () => import('./renderer.js')) {
  const page = new URL(host.location.href);
  let controller;
  let ready = false;
  let closed = false;
  let paused = page.searchParams.get('paused') === '1';
  let fitMode = page.searchParams.get('fit') || 'cover';
  let muted = page.searchParams.get('muted') !== '0';
  const requestedVolume = Number(page.searchParams.get('volume') ?? 0.3);
  let volume = Number.isFinite(requestedVolume) ? Math.max(0, Math.min(1, requestedVolume)) : 0.3;
  let userProperties = {};
  const startedAt = Date.now();
  let phase = 'renderer-import';
  let packageBytes = null;
  let sceneInfo = null;
  const snapshotRequestIds = new Set();
  let snapshotPending = false;
  let lastSnapshotAt = -Infinity;
  let pausedSnapshot = null;
  let retainedSnapshot = null;
  let pauseSnapshotPending = false;
  let pauseSnapshotPromise = null;
  let stalledSince = null;
  let diagnosticsTimer;
  const warnings = [];
  const notify = value => host.parent.postMessage(value, '*');
  const report = () => {
    if (closed) return;
    const frame = controller?.diagnostics?.() || {};
    const inactive = paused || host.document?.hidden === true;
    const stopped = ready && !inactive && !frame.idle && !frame.occluded
      && Number.isFinite(frame.lastRenderAgeMs) && frame.lastRenderAgeMs > 5000;
    if (!stopped) stalledSince = null;
    else stalledSince ??= Date.now();
    notify({ type: 'codex-scene-diagnostics', diagnostics: {
      ...frame, ...sceneInfo, phase, ready, paused, packageBytes,
      elapsedMs: Date.now() - startedAt,
      loadingSlow: !ready && !inactive && Date.now() - startedAt > 60000,
      stalled: stopped, stalledSince, warnings: [...warnings],
    } });
  };
  const fit = () => fitMode === 'fill' ? 'stretch' : fitMode;
  const dispose = () => {
    if (closed) return;
    closed = true;
    host.removeEventListener('message', command);
    host.removeEventListener('pagehide', dispose);
    host.removeEventListener('webglcontextlost', contextLost, true);
    if (diagnosticsTimer !== undefined) host.clearInterval(diagnosticsTimer);
    controller?.release();
  };
  const fail = error => {
    if (closed) return;
    notify({ type: 'codex-scene-error', message: String(error?.message || error) });
    dispose();
  };
  const contextLost = () => fail(new Error('WebGL context lost during Scene rendering.'));
  const rememberSnapshotRequest = requestId => {
    snapshotRequestIds.add(requestId);
    if (snapshotRequestIds.size > 32) snapshotRequestIds.delete(snapshotRequestIds.values().next().value);
  };
  const validSnapshot = snapshot => snapshot && Number.isInteger(snapshot.width) && Number.isInteger(snapshot.height)
    && snapshot.width > 0 && snapshot.height > 0 && typeof snapshot.dataUrl === 'string'
    && snapshot.dataUrl.startsWith('data:image/');
  const preservePauseSnapshot = () => {
    if (paused && retainedSnapshot) {
      pausedSnapshot = retainedSnapshot;
      controller?.pause();
      return;
    }
    if (!paused || !controller || pauseSnapshotPending || pausedSnapshot || typeof controller.snapshot !== 'function') {
      if (!pauseSnapshotPending) controller?.pause();
      return;
    }
    const snapshotController = controller;
    pauseSnapshotPending = true;
    snapshotController.setVolume(0);
    pauseSnapshotPromise = snapshotController.snapshot().then(snapshot => {
      if (!closed && controller === snapshotController && validSnapshot(snapshot)) {
        pausedSnapshot = snapshot;
        retainedSnapshot = snapshot;
      }
      return snapshot;
    }).catch(() => null).finally(() => {
      pauseSnapshotPending = false;
      pauseSnapshotPromise = null;
      if (!closed && paused && controller === snapshotController) snapshotController.pause();
    });
  };
  const sync = () => {
    if (!ready || !controller) return;
    controller.applyUserProperties?.(userProperties);
    if (paused) {
      if (typeof controller.snapshot !== 'function') {
        controller.pause();
        controller.setVolume(0);
        return;
      }
      controller.setVolume(0);
      preservePauseSnapshot();
      return;
    }
    pausedSnapshot = null;
    controller.resume();
    controller.setVolume(muted ? 0 : volume);
  };
  const captureSnapshot = async requestId => {
    const snapshotController = controller;
    snapshotPending = true;
    try {
      const snapshot = pausedSnapshot || (pauseSnapshotPending
        ? await pauseSnapshotPromise
        : await snapshotController.snapshot?.());
      if (closed || !ready || controller !== snapshotController) return;
      if (!validSnapshot(snapshot)) throw new Error('The Scene renderer returned no preview image.');
      retainedSnapshot = snapshot;
      rememberSnapshotRequest(requestId);
      lastSnapshotAt = Date.now();
      notify({ type: 'codex-scene-snapshot', requestId, ...snapshot, ...sceneInfo });
    } catch (error) {
      if (!closed && ready && controller === snapshotController) {
        rememberSnapshotRequest(requestId);
        lastSnapshotAt = Date.now();
        notify({ type: 'codex-scene-snapshot-error', requestId, message: String(error?.message || error).slice(0, 300) });
      }
    } finally {
      snapshotPending = false;
    }
  };
  const command = event => {
    if (event.source !== host.parent) return;
    if (event.data?.type === 'codex-scene-pointer') {
      if (!ready || !controller) return;
      const data = event.data;
      if (data.action === 'leave') controller.pointerLeave?.();
      else if (!paused && data.action === 'move' && Number.isFinite(data.u) && Number.isFinite(data.v)
          && data.u >= 0 && data.u <= 1 && data.v >= 0 && data.v <= 1) {
        controller.pushPointer?.(data.u, data.v, Number(data.buttons) || 0, Number(data.mods) || 0);
      } else if (!paused && data.action === 'wheel' && Number.isFinite(data.dx) && Number.isFinite(data.dy)) {
        controller.pushWheel?.(data.dx, data.dy, Number(data.mode) || 0, Number(data.mods) || 0);
      }
      return;
    }
    if (event.data?.type === 'codex-scene-snapshot-request') {
      const requestId = event.data.requestId;
      if (typeof requestId !== 'string' || !requestId || requestId.length > 160) return;
      const throttled = Date.now() - lastSnapshotAt < 2000 && !(paused && pausedSnapshot);
      if (!ready || !controller || snapshotPending || snapshotRequestIds.has(requestId)
          || throttled) {
        notify({ type: 'codex-scene-snapshot-error', requestId,
          message: snapshotPending ? 'A preview capture is already in progress.'
            : throttled ? 'Please wait two seconds before refreshing the preview.'
              : 'The Scene renderer is not ready for a preview capture.' });
        return;
      }
      void captureSnapshot(requestId);
      return;
    }
    if (event.data?.type !== 'codex-scene-playback') return;
    paused = event.data.paused === true;
    if (typeof event.data.muted === 'boolean') muted = event.data.muted;
    if (Number.isFinite(event.data.volume)) volume = Math.max(0, Math.min(1, event.data.volume));
    if (event.data.properties && typeof event.data.properties === 'object' && !Array.isArray(event.data.properties)) {
      userProperties = event.data.properties;
    }
    if (['cover', 'contain', 'fill'].includes(event.data.fitMode)) {
      fitMode = event.data.fitMode;
      controller?.setFit(fit());
    }
    sync();
  };
  host.addEventListener('message', command);
  host.addEventListener('pagehide', dispose);
  host.addEventListener('webglcontextlost', contextLost, true);
  report();
  if (host.setInterval) diagnosticsTimer = host.setInterval(report, 1000);
  try {
    const { mountCodexScene } = await loadRenderer();
    if (closed) return;
    const request = async (file, signal) => {
      phase = file === 'scene.pkg' ? 'package-download' : 'project-metadata';
      report();
      const response = await host.fetch(new URL(file, page), { signal });
      if (!response.ok) throw new Error(`Scene ${file} request failed (HTTP ${response.status}).`);
      return response;
    };
    phase = 'scene-initialization';
    controller = mountCodexScene({
      type: 'scene',
      fit: fit(),
      muted: true,
      source: {
        key: new URL('scene.pkg', page).href,
        scenePkg: async signal => {
          const bytes = await (await request('scene.pkg', signal)).arrayBuffer();
          packageBytes = bytes.byteLength;
          phase = 'scene-initialization';
          report();
          return bytes;
        },
        project: async signal => (await request('project.json', signal)).json(),
      },
    }, {
      onReady: () => {
        if (closed || ready) return;
        ready = true;
        phase = 'ready';
        sync();
        notify({ type: 'codex-scene-ready', ...sceneInfo });
      },
      onSceneInfo: info => {
        const sourceWidth = Number(info?.width);
        const sourceHeight = Number(info?.height);
        if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return;
        sceneInfo = { sourceWidth: Math.round(sourceWidth), sourceHeight: Math.round(sourceHeight) };
        report();
      },
      onError: fail,
      onDiagnostic: (message, level) => {
        if (level === 'warn') {
          warnings.push(String(message).slice(0, 300));
          if (warnings.length > 8) warnings.shift();
        }
        if (level === 'error') fail(new Error(message));
      },
    });
    if (closed) controller.release();
    else sync();
  } catch (error) {
    fail(error);
  }
}
