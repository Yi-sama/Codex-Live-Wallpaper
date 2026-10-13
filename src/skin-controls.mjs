export function normalizeRotation(value = {}, sources = null) {
  const allowed = sources ? new Set(sources.map(source => source.id)) : null;
  const ids = Array.isArray(value?.ids)
    ? [...new Set(value.ids.filter(id => typeof id === 'string' && (!allowed || allowed.has(id))))].slice(0, 500)
    : [];
  return {
    enabled: value?.enabled === true && ids.length > 1,
    ids,
    intervalSeconds: Number.isFinite(value?.intervalSeconds) ? Math.max(5, Math.min(43200, Math.round(value.intervalSeconds))) : 300,
    transition: value?.transition === 'none' ? 'none' : 'fade',
    durationMs: Number.isFinite(value?.durationMs) ? Math.max(100, Math.min(2000, Math.round(value.durationMs))) : 500,
  };
}

// Serialized into the existing CDP injection; no external browser dependencies.
export function installSkinFeatures({ cfg, panel, requestSelection, persistSettings, isBusy, getMedia, sceneOrigin }) {
  const cleanups = [];
  const listen = (target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    cleanups.push(() => target.removeEventListener(name, handler, options));
  };
  const inactive = () => document.hidden || !document.hasFocus();
  let remaining = cfg.rotation.intervalSeconds * 1000;
  let lastTick = Date.now();
  const step = direction => {
    const ids = cfg.rotation.ids;
    if (ids.length < 2 || isBusy()) return;
    const index = ids.indexOf(cfg.currentId);
    const next = index < 0 ? (direction > 0 ? 0 : ids.length - 1) : (index + direction + ids.length) % ids.length;
    requestSelection(ids[next]);
  };
  const tick = () => {
    const now = Date.now();
    if (!inactive() && !isBusy()) {
      remaining -= now - lastTick;
      if (remaining <= 0) {
        remaining = cfg.rotation.intervalSeconds * 1000;
        step(1);
      }
    }
    lastTick = now;
  };
  let timer = null;
  const schedule = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = cfg.rotation.enabled ? window.setInterval(tick, 1000) : null;
    remaining = cfg.rotation.intervalSeconds * 1000;
    lastTick = Date.now();
  };
  listen(window, 'focus', () => { lastTick = Date.now(); });
  listen(window, 'blur', () => { tick(); });
  listen(document, 'visibilitychange', () => { lastTick = Date.now(); });
  schedule();
  cleanups.push(() => { if (timer !== null) window.clearInterval(timer); });

  let pointerFrame = null;
  let pendingPointer = null;
  let pointerInside = false;
  const postPointer = data => {
    if (cfg.mode !== 'scene' || !sceneOrigin || isBusy()) return;
    getMedia().contentWindow?.postMessage({ type: 'codex-scene-pointer', ...data }, sceneOrigin);
  };
  const leave = () => {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = null;
    pendingPointer = null;
    if (pointerInside) postPointer({ action: 'leave' });
    pointerInside = false;
  };
  const pointer = event => {
    if (!cfg.mouseEnabled || inactive() || cfg.mode !== 'scene' || isBusy()
        || event.target?.closest?.('input,textarea,select,button,a,[contenteditable],[role="textbox"],[role="slider"],[role="menu"],[role="dialog"],#codex-wallpaper-engine-skin-controls')) {
      leave();
      return null;
    }
    const rect = getMedia().getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
      leave();
      return null;
    }
    pointerInside = true;
    return { action: 'move', u, v, buttons: event.buttons || 0,
      mods: Number(event.shiftKey) | (Number(event.ctrlKey) << 1) | (Number(event.altKey) << 2) | (Number(event.metaKey) << 3) };
  };
  listen(document, 'pointermove', event => {
    const data = pointer(event);
    if (!data) return;
    pendingPointer = data;
    if (pointerFrame === null) pointerFrame = requestAnimationFrame(() => {
      pointerFrame = null;
      if (pendingPointer) postPointer(pendingPointer);
      pendingPointer = null;
    });
  }, { capture: true, passive: true });
  for (const name of ['pointerdown', 'pointerup']) listen(document, name, event => {
    const data = pointer(event);
    if (data) {
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      pointerFrame = null;
      pendingPointer = null;
      postPointer(data);
    }
  }, { capture: true, passive: true });
  listen(document, 'wheel', event => {
    const data = pointer(event);
    if (!data) return;
    postPointer(data);
    postPointer({ action: 'wheel', dx: event.deltaX, dy: event.deltaY, mode: event.deltaMode, mods: data.mods });
  }, { capture: true, passive: true });
  listen(document, 'pointerout', event => { if (!event.relatedTarget) leave(); }, { passive: true });
  listen(window, 'blur', leave);
  listen(document, 'visibilitychange', () => { if (inactive()) leave(); });
  cleanups.push(leave);

  if (panel) {
    const adjustments = [...panel.children].slice(cfg.sourceOptions.length ? 4 : 3);
    const make = (tag, text, parent) => {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (parent) parent.appendChild(element);
      return element;
    };
    const button = (symbol, title, parent, handler) => {
      const element = make('button', symbol, parent);
      element.type = 'button';
      element.title = title;
      element.setAttribute('aria-label', title);
      element.style.cssText = 'min-width:30px;height:30px;padding:3px 7px;border:1px solid #54585e;border-radius:6px;background:#292c30;color:#f5f6f8;cursor:pointer';
      element.addEventListener('click', handler);
      return element;
    };
    const section = title => {
      const details = make('details', undefined, panel);
      details.style.cssText = 'border-top:1px solid #484b50;margin-top:12px;padding-top:10px';
      const summary = make('summary', title, details);
      summary.style.cssText = 'cursor:pointer;font-weight:650;margin-bottom:8px';
      return details;
    };
    const library = section('\u58c1\u7eb8\u5e93');
    if (cfg.mode === 'picker') {
      button('\u21bb', '\u5237\u65b0\u58c1\u7eb8', library, () => {
        window.codexSkinCommand?.(JSON.stringify({ action: 'refresh-sources', controllerId: cfg.controllerId }));
      });
    }
    library.open = window.__codexWallpaperLibraryOpen === true;
    library.addEventListener('toggle', () => { window.__codexWallpaperLibraryOpen = library.open; });
    const filters = make('div', undefined, library);
    filters.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 82px;gap:6px;margin:8px 0';
    const search = make('input', undefined, filters);
    search.type = 'search';
    search.placeholder = '\u641c\u7d22\u540d\u79f0\u6216 ID';
    search.setAttribute('aria-label', '\u641c\u7d22\u58c1\u7eb8');
    search.value = window.__codexWallpaperLibraryQuery || '';
    const type = make('select', undefined, filters);
    type.setAttribute('aria-label', '\u58c1\u7eb8\u7c7b\u578b');
    for (const [value, label] of [['all', '\u5168\u90e8'], ['video', '\u89c6\u9891'], ['scene', 'Scene'], ['preview', '\u9884\u89c8']]) {
      const option = make('option', label, type);
      option.value = value;
    }
    type.value = window.__codexWallpaperLibraryType || 'all';
    for (const input of [search, type]) input.style.cssText = 'min-width:0;width:100%;box-sizing:border-box;background:#24272b;color:#f5f6f8;border:1px solid #54585e;border-radius:6px;padding:6px';
    const count = make('div', undefined, library);
    count.setAttribute('role', 'status');
    count.style.cssText = 'color:#bcc1c8;margin:6px 0';
    const grid = make('div', undefined, library);
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:300px;overflow-y:auto';
    const renderLibrary = () => {
      grid.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const sources = cfg.sourceOptions.filter(item => (!query || (item.title + ' ' + item.id).toLocaleLowerCase().includes(query))
        && (type.value === 'all' || (type.value === 'preview' ? item.skinMode === 'preview' : item.type === type.value && item.skinMode !== 'preview')));
      count.textContent = sources.length ? sources.length + ' \u5f20\u58c1\u7eb8' : '\u65e0\u5339\u914d\u58c1\u7eb8';
      for (const item of sources) {
        const tile = make('div', undefined, grid);
        tile.style.cssText = 'min-width:0;overflow:hidden;border:1px solid ' + (item.id === cfg.currentId ? '#64c8ba' : '#51555a') + ';border-radius:6px;background:#25282c';
        const choose = make('button', undefined, tile);
        choose.type = 'button';
        choose.title = item.title;
        choose.setAttribute('aria-label', '\u5e94\u7528 ' + item.title);
        choose.setAttribute('aria-pressed', String(item.id === cfg.currentId));
        choose.style.cssText = 'display:block;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer';
        const image = make('img', undefined, choose);
        image.alt = '';
        image.loading = 'lazy';
        image.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#393d42';
        if (item.thumbnailUrl) image.src = item.thumbnailUrl;
        image.addEventListener('error', () => { image.removeAttribute('src'); });
        const title = make('span', item.title, choose);
        title.style.cssText = 'display:block;padding:6px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        const kind = make('span', item.skinMode === 'preview' ? '\u9884\u89c8' : item.type || '', choose);
        kind.style.cssText = 'display:block;padding:0 6px 6px;font-size:11px;color:#b9bfc7';
        choose.addEventListener('click', () => { if (item.id !== cfg.currentId) requestSelection(item.id); });
        const row = make('label', undefined, tile);
        row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:5px 6px;border-top:1px solid #454a50;font-size:11px';
        const include = make('input', undefined, row);
        include.type = 'checkbox';
        include.checked = cfg.rotation.ids.includes(item.id);
        include.setAttribute('aria-label', '\u8f6e\u64ad ' + item.title);
        make('span', '\u52a0\u5165\u8f6e\u64ad', row);
        include.addEventListener('change', () => {
          cfg.rotation.ids = include.checked ? [...new Set([...cfg.rotation.ids, item.id])] : cfg.rotation.ids.filter(id => id !== item.id);
          if (cfg.rotation.ids.length < 2) cfg.rotation.enabled = false;
          schedule();
          renderRotation();
          persistSettings();
        });
      }
    };
    for (const [input, name] of [[search, 'input'], [type, 'change']]) input.addEventListener(name, () => {
      window.__codexWallpaperLibraryQuery = search.value;
      window.__codexWallpaperLibraryType = type.value;
      renderLibrary();
    });
    const rotation = section('\u8f6e\u64ad');
    const toolbar = make('div', undefined, rotation);
    toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;margin:8px 0';
    button('\u25c0', '\u4e0a\u4e00\u5f20', toolbar, () => step(-1));
    const play = button('\u25b6', '\u5f00\u59cb\u8f6e\u64ad', toolbar, () => {
      cfg.rotation.enabled = !cfg.rotation.enabled;
      schedule();
      renderRotation();
      persistSettings();
    });
    button('\u25b6\u2758', '\u4e0b\u4e00\u5f20', toolbar, () => step(1));
    const interval = make('input', undefined, toolbar);
    interval.type = 'number';
    interval.min = '5';
    interval.max = '86400';
    interval.value = cfg.rotation.intervalSeconds;
    interval.setAttribute('aria-label', '\u8f6e\u64ad\u95f4\u9694\uff08\u79d2\uff09');
    interval.style.cssText = 'min-width:0;width:70px;background:#24272b;color:#fff;border:1px solid #54585e;border-radius:6px;padding:5px';
    make('span', '\u79d2', toolbar);
    interval.addEventListener('change', () => {
      const value = Number(interval.value);
      if (Number.isFinite(value)) cfg.rotation.intervalSeconds = Math.max(5, Math.min(86400, Math.round(value)));
      interval.value = cfg.rotation.intervalSeconds;
      schedule();
      persistSettings();
    });
    const transition = make('select', undefined, rotation);
    transition.setAttribute('aria-label', '\u8f6c\u573a');
    transition.style.cssText = 'width:100%;background:#24272b;color:#fff;padding:5px;border:1px solid #54585e;border-radius:6px';
    for (const [value, label] of [['fade', '\u6de1\u5165\u6de1\u51fa'], ['none', '\u76f4\u63a5\u5207\u6362']]) {
      const option = make('option', label, transition);
      option.value = value;
    }
    transition.value = cfg.rotation.transition;
    transition.addEventListener('change', () => { cfg.rotation.transition = transition.value; persistSettings(); });
    const list = make('div', undefined, rotation);
    const renderRotation = () => {
      play.disabled = cfg.rotation.ids.length < 2;
      play.textContent = cfg.rotation.enabled ? '\u23f8' : '\u25b6';
      play.title = cfg.rotation.enabled ? '\u6682\u505c\u8f6e\u64ad' : '\u5f00\u59cb\u8f6e\u64ad';
      play.setAttribute('aria-label', play.title);
      list.replaceChildren();
      cfg.rotation.ids.forEach((id, index) => {
        const row = make('div', undefined, list);
        row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:6px;min-width:0';
        const label = make('span', cfg.sourceOptions.find(item => item.id === id)?.title || id, row);
        label.style.cssText = 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        label.title = label.textContent;
        const up = button('\u2191', '\u4e0a\u79fb', row, () => {
          [cfg.rotation.ids[index - 1], cfg.rotation.ids[index]] = [id, cfg.rotation.ids[index - 1]];
          renderRotation();
          persistSettings();
        });
        up.disabled = index === 0;
        button('\u00d7', '\u79fb\u51fa\u8f6e\u64ad', row, () => {
          cfg.rotation.ids = cfg.rotation.ids.filter(value => value !== id);
          if (cfg.rotation.ids.length < 2) cfg.rotation.enabled = false;
          schedule();
          renderRotation();
          renderLibrary();
          persistSettings();
        });
      });
    };
    renderLibrary();
    renderRotation();
    const mouse = make('label', undefined, panel);
    mouse.style.cssText = 'display:flex;gap:7px;align-items:center;margin-top:12px';
    const enabled = make('input', undefined, mouse);
    enabled.type = 'checkbox';
    enabled.checked = cfg.mouseEnabled;
    make('span', '\u573a\u666f\u9f20\u6807\u4ea4\u4e92', mouse);
    enabled.addEventListener('change', () => {
      cfg.mouseEnabled = enabled.checked;
      if (!cfg.mouseEnabled) leave();
      persistSettings();
    });
    const nav = make('div');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', '\u58c1\u7eb8\u63a7\u5236');
    nav.style.cssText = 'display:flex;gap:4px;margin:8px 0 12px';
    panel.insertBefore(nav, adjustments[0] || library);
    const groups = { adjustments: [...adjustments, mouse], library: [library], rotation: [rotation] };
    const displays = new Map(Object.values(groups).flat().map(element => [element, element.style.display || '']));
    const tabs = new Map();
    const showTab = key => {
      window.__codexWallpaperPanelTab = key;
      for (const [name, elements] of Object.entries(groups)) {
        elements.forEach(element => { element.style.display = name === key ? displays.get(element) : 'none'; });
        const tab = tabs.get(name);
        tab.setAttribute('aria-selected', String(name === key));
        tab.tabIndex = name === key ? 0 : -1;
        tab.style.borderColor = name === key ? '#64c8ba' : '#54585e';
      }
    };
    for (const [key, label] of [['adjustments', '\u8c03\u6574'], ['library', '\u58c1\u7eb8\u5e93'], ['rotation', '\u8f6e\u64ad']]) {
      const tab = button(label, label, nav, () => showTab(key));
      tab.setAttribute('role', 'tab');
      tab.style.flex = '1';
      if (cfg.mode === 'picker' && key !== 'library') { tab.disabled = true; tab.style.display = 'none'; }
      tabs.set(key, tab);
    }
    for (const element of [library, rotation]) {
      element.open = true;
      element.children[0].style.display = 'none';
      element.style.borderTop = '0';
      element.style.marginTop = '0';
      element.style.paddingTop = '0';
    }
    nav.addEventListener('keydown', event => {
      const keys = [...tabs.keys()].filter(key => !tabs.get(key).disabled);
      const current = keys.indexOf(window.__codexWallpaperPanelTab);
      const index = event.key === 'ArrowRight' ? (current + 1) % keys.length
        : event.key === 'ArrowLeft' ? (current + keys.length - 1) % keys.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : null;
      if (index === null) return;
      event.preventDefault();
      showTab(keys[index]);
      tabs.get(keys[index]).focus();
    });
    showTab(Object.hasOwn(groups, window.__codexWallpaperPanelTab) ? window.__codexWallpaperPanelTab : 'adjustments');
  }
  const cleanup = () => { cleanups.reverse().forEach(dispose => dispose()); };
  cleanup.schedule = schedule;
  return cleanup;
}
