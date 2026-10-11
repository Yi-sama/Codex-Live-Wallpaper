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
  const notify = value => host.parent.postMessage(value, '*');
  const fit = () => fitMode === 'fill' ? 'stretch' : fitMode;
  const sync = () => {
    if (!ready || !controller) return;
    controller.applyUserProperties?.(userProperties);
    if (paused) controller.pause();
    else controller.resume();
    controller.setVolume(muted || paused ? 0 : volume);
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    host.removeEventListener('message', command);
    host.removeEventListener('pagehide', dispose);
    controller?.release();
  };
  const fail = error => {
    if (closed) return;
    notify({ type: 'codex-scene-error', message: String(error?.message || error) });
    dispose();
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
  try {
    const { mountCodexScene } = await loadRenderer();
    if (closed) return;
    const request = async (file, signal) => {
      const response = await host.fetch(new URL(file, page), { signal });
      if (!response.ok) throw new Error(`Scene ${file} request failed (HTTP ${response.status}).`);
      return response;
    };
    controller = mountCodexScene({
      type: 'scene',
      fit: fit(),
      muted: true,
      source: {
        key: new URL('scene.pkg', page).href,
        scenePkg: async signal => (await request('scene.pkg', signal)).arrayBuffer(),
        project: async signal => (await request('project.json', signal)).json(),
      },
    }, {
      onReady: () => {
        if (closed || ready) return;
        ready = true;
        sync();
        notify({ type: 'codex-scene-ready' });
      },
      onError: fail,
      onDiagnostic: (message, level) => {
        if (level === 'error') fail(new Error(message));
      },
    });
    if (closed) controller.release();
    else sync();
  } catch (error) {
    fail(error);
  }
}
