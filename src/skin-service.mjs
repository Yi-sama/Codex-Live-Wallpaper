import { readSavedSkinState } from './codex-skin.mjs';

// The launcher owns this bridge; it does not depend on a chat's MCP lifetime.
export async function runSkinService({ bridge, isRunning, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onReady = () => {}, onError = console.error }) {
  try {
    if (!isRunning()) return;
    const initial = readSavedSkinState(bridge.stateFile);
    if (initial) await bridge.apply(initial, { reuseExisting: true });
    else await bridge.showPicker();
    onReady();
    while (isRunning()) {
      await wait(2000);
      if (!isRunning()) break;
      try {
        const saved = readSavedSkinState(bridge.stateFile);
        if (saved && (bridge.active?.currentId !== saved.id || !bridge.active)) {
          await bridge.apply(saved, { reuseExisting: true });
        } else if (!saved && bridge.saved) {
          await bridge.remove();
        } else if (bridge.active?.mode === 'picker') {
          await bridge.injectCurrent({ onlyNew: true });
        }
      } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    }
  } finally { await bridge.disconnect(); }
}
