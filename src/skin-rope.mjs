// Serialized into the skin injection. Position belongs to the UI, not a wallpaper.
export function installSkinRope({ controls, toggle, panel, imageUrl }) {
  const lengthKey = 'codex-wallpaper-rope-length';
  const leftKey = 'codex-wallpaper-rope-left';
  const read = (key, fallback) => {
    try {
      const value = window.localStorage.getItem(key);
      return value === null || !Number.isFinite(Number(value)) ? fallback : Number(value);
    } catch { return fallback; }
  };
  let preferred = window.__codexWallpaperRopeLength ?? read(lengthKey, 56);
  preferred = Number.isFinite(preferred) ? Math.max(16, Math.min(560, preferred)) : 56;
  let preferredLeft = window.__codexWallpaperRopeLeft ?? read(leftKey, null);
  let drag = null;
  let suppressClick = false;
  const viewport = () => ({ width: window.innerWidth || 1280, height: window.innerHeight || 816 });
  const size = () => viewport().width <= 480 ? 70 : 84;
  const maximum = () => Math.max(16, Math.min(560, Math.floor(viewport().height - size() * 400 / 288 - 12)));
  const clampLeft = value => Math.max(12, Math.min(viewport().width - size() - 12, value));
  const visibleLeft = () => clampLeft(Number.isFinite(preferredLeft) ? preferredLeft : viewport().width <= 480 ? 12 : 24);
  const render = () => {
    const { width, height } = viewport();
    const length = Math.min(preferred, maximum());
    const left = visibleLeft();
    const imageHeight = size() * 400 / 288;
    const panelWidth = Math.min(320, width - 24);
    let panelLeft = left + size() + 12;
    let panelTop = Math.max(12, Math.min(length + 6, height - 220));
    let panelHeight = height - panelTop - 12;
    if (panelLeft + panelWidth > width - 12) {
      if (left - panelWidth - 12 >= 12) {
        panelLeft = left - panelWidth - 12;
      } else {
        panelLeft = Math.max(12, Math.min(left, width - panelWidth - 12));
        const below = height - length - imageHeight - 24;
        const above = length - 24;
        const placeBelow = below >= 220 || below >= above;
        panelTop = placeBelow ? length + imageHeight + 12 : 12;
        panelHeight = Math.max(0, placeBelow ? below : above);
      }
    }
    for (const [name, value] of Object.entries({
      length, left, size: size(), 'panel-left': panelLeft, 'panel-top': panelTop,
      'panel-width': panelWidth, 'panel-height': panelHeight,
    })) controls.style.setProperty('--codex-rope-' + name, value + 'px');
    window.__codexWallpaperRopeLength = preferred;
    window.__codexWallpaperRopeLeft = preferredLeft;
  };
  const move = (value, left = preferredLeft) => {
    preferred = Math.max(16, Math.min(maximum(), value));
    preferredLeft = Number.isFinite(left) ? clampLeft(left) : null;
    render();
    try {
      window.localStorage.setItem(lengthKey, String(preferred));
      if (preferredLeft !== null) window.localStorage.setItem(leftKey, String(preferredLeft));
    } catch { /* UI works without storage. */ }
  };
  const syncOpen = () => toggle.setAttribute('aria-expanded', String(panel.style.display !== 'none'));
  toggle.textContent = '';
  toggle.type = 'button';
  toggle.title = '\u76ae\u80a4\u8c03\u6574';
  toggle.setAttribute('aria-label', toggle.title);
  panel.id = controls.id + '-panel';
  toggle.setAttribute('aria-controls', panel.id);
  toggle.setAttribute('data-rope-handle', '');
  Object.assign(controls.style, { inset: '0', right: '0', bottom: '0', width: 'auto', maxWidth: 'none', pointerEvents: 'none' });
  toggle.style.cssText = '';
  Object.assign(panel.style, {
    position: 'fixed', left: 'var(--codex-rope-panel-left)', top: 'var(--codex-rope-panel-top)',
    clear: 'none', marginTop: '0', boxSizing: 'border-box',
    width: 'var(--codex-rope-panel-width)', maxWidth: 'calc(100vw - 24px)',
    maxHeight: 'var(--codex-rope-panel-height)', pointerEvents: 'auto',
  });
  const strand = document.createElement('span');
  strand.setAttribute('data-rope-strand', '');
  strand.setAttribute('aria-hidden', 'true');
  strand.title = '\u62c9\u7ef3';
  const pendant = document.createElement('img');
  pendant.setAttribute('data-rope-pendant', '');
  pendant.setAttribute('aria-hidden', 'true');
  pendant.src = imageUrl;
  pendant.alt = '';
  pendant.draggable = false;
  toggle.append(strand, pendant);
  const style = document.createElement('style');
  style.textContent = `
    #codex-wallpaper-engine-skin-controls>[data-rope-handle]{
      position:fixed;top:var(--codex-rope-length);left:var(--codex-rope-left);
      width:var(--codex-rope-size);height:calc(var(--codex-rope-size) * 400 / 288);
      display:block;padding:0;margin:0;border:0;background:none;
      box-shadow:none;float:none;cursor:grab;pointer-events:auto;touch-action:none;
      user-select:none;-webkit-app-region:no-drag;transition:top .14s ease-out,left .14s ease-out;
      border-radius:8px;
    }
    #codex-wallpaper-engine-skin-controls>[data-rope-handle]:focus-visible{
      outline:2px solid #6fb7a8;outline-offset:3px;
    }
    #codex-wallpaper-engine-skin-controls>[data-rope-dragging]{cursor:grabbing;transition:none}
    #codex-wallpaper-engine-skin-controls [data-rope-strand]{
      position:absolute;left:38.7316%;bottom:100%;width:24px;height:var(--codex-rope-length);
      transform:translateX(-50%);transition:height .14s ease-out;
      touch-action:none;-webkit-app-region:no-drag;cursor:grab;
    }
    #codex-wallpaper-engine-skin-controls [data-rope-strand]:before{
      content:"";position:absolute;left:10.5px;top:0;width:3px;height:calc(100% + 2px);
      background:repeating-linear-gradient(32deg,#a38c5a 0 2px,#f4e6c4 2px 4px,#c6ad79 4px 6px);
      border-left:1px solid rgba(64,49,26,.28);border-right:1px solid rgba(255,255,255,.48);
      box-shadow:1px 0 2px rgba(0,0,0,.22);box-sizing:border-box;
    }
    #codex-wallpaper-engine-skin-controls [data-rope-pendant]{
      display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;
      user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 2px 2px rgba(0,0,0,.22));
      transform-origin:38.7316% 0;animation:codex-wallpaper-mascot-sway 4s ease-in-out infinite;
    }
    @keyframes codex-wallpaper-mascot-sway{
      0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}
    }
    #codex-wallpaper-engine-skin-controls>[data-rope-dragging] [data-rope-strand]{transition:none;cursor:grabbing}
    #codex-wallpaper-engine-skin-controls>[data-rope-dragging] [data-rope-pendant]{animation-play-state:paused}
    @media(prefers-reduced-motion:reduce){
      #codex-wallpaper-engine-skin-controls>[data-rope-handle],
      #codex-wallpaper-engine-skin-controls [data-rope-strand]{transition:none}
      #codex-wallpaper-engine-skin-controls [data-rope-pendant]{animation:none}
    }
  `;
  controls.appendChild(style);
  const wheel = event => {
    if (drag || event.ctrlKey || event.metaKey || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport().height : 1;
    move(Math.min(preferred, maximum()) + Math.max(-32, Math.min(32, event.deltaY * unit * 0.35)));
  };
  const updateDrag = () => {
    if (!drag.ready || (!drag.moved && (drag.rope ? Math.abs(drag.dy) : Math.hypot(drag.dx, drag.dy)) < 5)) return;
    drag.moved = true;
    toggle.setAttribute('data-rope-dragging', '');
    move(drag.length + drag.dy, drag.rope ? drag.left : drag.left + drag.dx);
  };
  const pointerDown = event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: visibleLeft(), length: Math.min(preferred, maximum()), moved: false,
      rope: event.target === strand, ready: event.target !== strand, dx: 0, dy: 0 };
    toggle.setPointerCapture(event.pointerId);
    if (drag.rope) {
      const held = drag;
      drag.timer = window.setTimeout(() => {
        if (drag !== held) return;
        drag.ready = true;
        toggle.setAttribute('data-rope-dragging', '');
        updateDrag();
      }, 250);
      event.preventDefault();
    }
    event.stopPropagation();
  };
  const pointerMove = event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    updateDrag();
    event.preventDefault();
    event.stopPropagation();
  };
  const pointerEnd = event => {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = event.type === 'pointerup' && (drag.moved || drag.rope);
    if (drag.timer !== undefined) window.clearTimeout(drag.timer);
    const pointerId = drag.id;
    drag = null;
    toggle.removeAttribute('data-rope-dragging');
    if (toggle.hasPointerCapture(pointerId)) toggle.releasePointerCapture(pointerId);
  };
  // The existing click listener predates this helper, so suppress drag-clicks in capture.
  const click = event => {
    const discard = suppressClick && event.detail !== 0;
    suppressClick = false;
    if (discard) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const key = event => {
    if (event.key === 'Escape' && panel.style.display !== 'none') {
      panel.style.display = 'none';
      window.__codexWallpaperControlsOpen = false;
      syncOpen();
      toggle.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target !== toggle) return;
    const change = { ArrowDown: 16, ArrowUp: -16, PageDown: 64, PageUp: -64 }[event.key];
    if (change === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    move(event.key === 'Home' ? 16 : event.key === 'End' ? maximum() : Math.min(preferred, maximum()) + change);
  };
  toggle.addEventListener('wheel', wheel, { passive: false });
  toggle.addEventListener('pointerdown', pointerDown);
  toggle.addEventListener('pointermove', pointerMove);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) toggle.addEventListener(type, pointerEnd);
  toggle.addEventListener('click', click, true);
  toggle.addEventListener('click', syncOpen);
  controls.addEventListener('keydown', key);
  window.addEventListener('resize', render);
  controls.ropeVersion = 4;
  render();
  syncOpen();
  return () => {
    if (drag) pointerEnd({ pointerId: drag.id });
    toggle.removeEventListener('wheel', wheel);
    toggle.removeEventListener('pointerdown', pointerDown);
    toggle.removeEventListener('pointermove', pointerMove);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) toggle.removeEventListener(type, pointerEnd);
    toggle.removeEventListener('click', click, true);
    toggle.removeEventListener('click', syncOpen);
    controls.removeEventListener('keydown', key);
    window.removeEventListener('resize', render);
    strand.remove();
    pendant.remove();
    style.remove();
    controls.ropeVersion = null;
  };
}
