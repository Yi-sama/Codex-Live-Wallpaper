import { prepareCodexScenePage } from '../src/codex-skin.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--port') {
    throw new Error('Usage: node prepare-codex-scene.mjs --port <actual-debug-port>');
  }
  console.log(JSON.stringify(await prepareCodexScenePage(Number(args[1]))));
} catch (error) {
  console.error(`Codex Scene initialization failed: ${error.message}`);
  process.exitCode = 1;
}
