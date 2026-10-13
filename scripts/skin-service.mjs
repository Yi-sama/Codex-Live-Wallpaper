import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexSkinBridge } from '../src/codex-skin.mjs';
import { runSkinService } from '../src/skin-service.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--port' || args[2] !== '--process-id') {
    throw new Error('Usage: node skin-service.mjs --port <debug-port> --process-id <Codex-pid>');
  }
  const port = Number(args[1]);
  const processId = Number(args[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Invalid Codex debug port or process id.');
  }
  const endpointFile = join(process.env.CODEX_SKIN_DATA_DIR, 'debug-endpoint.json');
  const isRunning = () => {
    try {
      const endpoint = JSON.parse(readFileSync(endpointFile, 'utf8'));
      if (endpoint.port !== port || endpoint.processId !== processId) return false;
      process.kill(processId, 0);
      return true;
    } catch { return false; }
  };
  await runSkinService({
    bridge: new CodexSkinBridge({ cdpPort: port, restoreIntervalMs: 0 }), isRunning,
    onReady: () => console.log(JSON.stringify({ ready: true, port, processId })),
  });
} catch (error) {
  console.error(`Codex wallpaper startup bridge failed: ${error.message}`);
  process.exitCode = 1;
}
