import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIR = fileURLToPath(new URL('./webwallgl', import.meta.url));
const RENDERER_FILE = resolve(RUNTIME_DIR, 'assets', 'renderer-DTLW1Gf0.js');
const POLYFILL_FILE = resolve(RUNTIME_DIR, 'assets', 'modulepreload-polyfill-B5Qt9EMX.js');
const POLYFILL_NAME = 'modulepreload-polyfill-B5Qt9EMX.js';
const PLAYER_FILE = fileURLToPath(new URL('./scene-player.mjs', import.meta.url));
// The pinned bundle keeps lifecycle callbacks private; expose them without editing the vendor file.
const RENDERER_ADAPTER = `
export function mountCodexScene(config, callbacks) {
  Te.onFirstFrame = callbacks.onReady;
  Te.onError = callbacks.onError;
  Te.onDiagnostic = callbacks.onDiagnostic;
  Te.userVolume = 0;
  window.__wp.setWallpaper(config);
  return {
    pause: () => window.__wp.pause(),
    resume: () => window.__wp.resume(),
    setFit: value => window.__wp.setFit(value),
    setVolume(value) {
      const wasSilent = !Te.userVolume;
      Te.userVolume = value;
      window.__wp.setVolume(value);
      if (wasSilent && value > 0 && !Te.paused) {
        for (const layer of window.__sceneLayers || []) {
          if (layer.soundCtl && (!layer.soundprops?.startsilent || layer.soundCtl.isPlaying())) layer.soundCtl.play();
        }
      }
    },
    applyUserProperties: values => window.__wp.updateWebProps?.(values),
    pushPointer: (u, v, buttons, mods) => window.__wp.pushPointer(u, v, buttons, mods),
    pointerLeave: () => window.__wp.pointerLeave(),
    pushWheel: (dx, dy, mode, mods) => window.__wp.pushWheel(dx, dy, mode, mods),
    release: () => window.__wp.release(),
  };
}
`;
// A running MCP can outlive its installed cache directory during a plugin update.
const RUNTIME_ASSETS = new Map([
  ['/renderer.js', { bytes: Buffer.concat([readFileSync(RENDERER_FILE), Buffer.from(RENDERER_ADAPTER)]), type: 'text/javascript; charset=utf-8' }],
  ['/scene-player.mjs', { bytes: readFileSync(PLAYER_FILE), type: 'text/javascript; charset=utf-8' }],
  [`/${POLYFILL_NAME}`, { bytes: readFileSync(POLYFILL_FILE), type: 'text/javascript; charset=utf-8' }],
]);
const SCENE_PAGE = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style><script type="module">import("/scene-player.mjs").then(({startScenePlayer})=>startScenePlayer()).catch(error=>parent.postMessage({type:"codex-scene-error",message:"Scene player startup failed: "+String(error?.message||error)},"*"));</script>';

function pathInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendBytes(res, bytes, contentType, method = 'GET') {
  setCors(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', bytes.byteLength);
  res.setHeader('Cache-Control', 'no-store');
  res.end(method === 'HEAD' ? undefined : bytes);
}

function sendFile(res, file, contentType, method) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  setCors(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', statSync(file).size);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => {
    if (!res.headersSent) res.statusCode = 500;
    res.destroy();
  }).pipe(res);
}

export class SceneRuntimeServer {
  constructor() {
    this.server = null;
    this.baseUrl = null;
    this.projects = new Map();
    this.previews = new Map();
  }

  async ensure() {
    if (this.server && this.baseUrl) return this.baseUrl;
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise((resolvePromise, reject) => {
      const onError = error => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address !== 'object' || !address.port) {
          reject(new Error('Scene runtime did not expose a loopback port.'));
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolvePromise();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
    this.server.unref();
    return this.baseUrl;
  }

  async prepare(project) {
    if (project.type !== 'scene' || !project.filePath || !project.projectPath) {
      throw new Error('Only packaged Scene projects can use the Scene runtime.');
    }
    if (!project.filePath.toLowerCase().endsWith('.pkg')) {
      throw new Error('This Scene project has no scene.pkg container.');
    }
    if (!pathInside(project.projectDir, project.filePath)) {
      throw new Error('Scene package path escaped its project directory.');
    }
    if (!existsSync(project.filePath) || !statSync(project.filePath).isFile()) {
      throw new Error('The selected scene.pkg is missing.');
    }
    const baseUrl = await this.ensure();
    const token = createHash('sha256')
      .update(`${resolve(project.filePath)}\n${statSync(project.filePath).size}\n${statSync(project.filePath).mtimeMs}`)
      .digest('hex')
      .slice(0, 32);
    this.projects.set(token, {
      projectPath: project.projectPath,
      projectDir: project.projectDir,
      filePath: project.filePath,
    });
    return {
      sceneRendererUrl: `${baseUrl}/renderer.js`,
      scenePageUrl: `${baseUrl}/scene/${token}/index.html`,
      sceneSourceUrl: `${baseUrl}/scene/${token}/scene.pkg`,
      sceneProjectUrl: `${baseUrl}/scene/${token}/project.json`,
    };
  }

  async librarySources(projects) {
    const baseUrl = await this.ensure();
    return projects.filter(project => project.skinMode !== 'unsupported'
      && (project.type === 'video' || project.skinMode === 'scene' || project.previewPath)).map(project => {
      let thumbnailUrl = null;
      const file = project.previewPath;
      if (file && pathInside(project.projectDir, file) && /\.(png|jpe?g|webp|gif)$/i.test(file)
          && existsSync(file) && statSync(file).isFile() && statSync(file).size <= 24 * 1024 * 1024) {
        const token = createHash('sha256').update(`${resolve(file)}\n${statSync(file).mtimeMs}`).digest('hex').slice(0, 32);
        const extension = /\.([^.]+)$/.exec(file)[1].toLowerCase();
        const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
        this.previews.set(token, { file, type });
        thumbnailUrl = `${baseUrl}/preview/${token}`;
      }
      return { id: project.id, title: project.title, type: project.type, source: project.source,
        skinMode: ['web', 'application'].includes(project.type) ? 'preview' : project.skinMode, thumbnailUrl };
    });
  }

  handle(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    const asset = RUNTIME_ASSETS.get(url.pathname);
    if (asset) {
      sendBytes(res, asset.bytes, asset.type, req.method);
      return;
    }
    const preview = /^\/preview\/([a-f0-9]{32})$/.exec(url.pathname);
    if (preview) {
      const entry = this.previews.get(preview[1]);
      if (entry) sendFile(res, entry.file, entry.type, req.method);
      else { res.statusCode = 404; res.end('unknown preview'); }
      return;
    }
    const match = /^\/scene\/([a-f0-9]{32})\/(scene\.pkg|project\.json|index\.html)$/.exec(url.pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const project = this.projects.get(match[1]);
    if (!project) {
      res.statusCode = 404;
      res.end('unknown scene');
      return;
    }
    if (match[2] === 'index.html') {
      sendBytes(res, Buffer.from(SCENE_PAGE), 'text/html; charset=utf-8', req.method);
      return;
    }
    if (match[2] === 'project.json') {
      try {
        sendBytes(res, readFileSync(project.projectPath), 'application/json; charset=utf-8', req.method);
      } catch {
        res.statusCode = 404;
        res.end('project not found');
      }
      return;
    }
    sendFile(res, project.filePath, 'application/octet-stream', req.method);
  }

  async close() {
    this.projects.clear();
    this.previews.clear();
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    if (!server) return;
    await new Promise(resolvePromise => server.close(() => resolvePromise()));
  }
}
