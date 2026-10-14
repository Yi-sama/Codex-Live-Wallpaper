import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const WE_APP_ID = '431960';

const COMMON_STEAM_DIRS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
];

function uniqueExistingDirectories(paths) {
  const seen = new Set();
  return paths
    .filter(Boolean)
    .map((value) => normalize(value))
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key) || !existsSync(value)) return false;
      seen.add(key);
      try { return statSync(value).isDirectory(); } catch { return false; }
    });
}

export function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const output = execFileSync(
      reg,
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(output);
    return match ? normalize(match[1].trim()) : null;
  } catch {
    return null;
  }
}

export function librariesFromVdfText(text) {
  const libraries = [];
  let currentPath = null;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*"path"\s+"([^"]+)"\s*$/.exec(line);
    if (match) currentPath = match[1].replace(/\\\\/g, '\\');
    if (currentPath && new RegExp(`"${WE_APP_ID}"\\s+"\\d+"`).test(line)) {
      libraries.push(normalize(currentPath));
      currentPath = null;
    }
  }
  return [...new Set(libraries)];
}

function steamRoots() {
  const override = process.env.WALLPAPER_ENGINE_STEAM_ROOT;
  return uniqueExistingDirectories([
    override,
    steamPathFromRegistry(),
    ...COMMON_STEAM_DIRS,
  ]);
}

export function wallpaperEngineSourceInfo() {
  const roots = steamRoots();
  const libraries = [];
  for (const root of roots) {
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf');
    if (existsSync(vdf)) {
      try { libraries.push(...librariesFromVdfText(readFileSync(vdf, 'utf8'))); } catch { /* malformed VDF */ }
    }
    if (existsSync(join(root, 'steamapps', 'common', 'wallpaper_engine'))) libraries.push(root);
  }

  const candidates = [
    process.env.WALLPAPER_ENGINE_HOME,
    ...[...roots, ...libraries].map((root) => join(root, 'steamapps', 'common', 'wallpaper_engine')),
    'C:\\Program Files (x86)\\Wallpaper Engine',
  ].filter(Boolean);

  let installDir = null;
  for (const candidate of candidates) {
    const dir = normalize(candidate);
    if (existsSync(join(dir, 'wallpaper64.exe')) || existsSync(join(dir, 'wallpaper32.exe'))) {
      installDir = dir;
      break;
    }
  }

  return {
    installed: Boolean(installDir),
    installDir,
    steamRoots: roots,
    libraryDirs: uniqueExistingDirectories([...roots, ...libraries]),
  };
}

function inferType(file) {
  if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return 'video';
  if (/\.html?$/i.test(file)) return 'web';
  if (/\.exe$/i.test(file)) return 'application';
  return 'scene';
}

const IMAGE_FILE = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
const STATIC_IMAGE_FILE = /\.(?:avif|bmp|jpe?g|png|webp)$/i;
const STATIC_TITLE = /\bstatic\b|静态/iu;

function positiveDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function readImageDimensions(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const bytes = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length < 10) return null;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && length >= 24) {
      return positiveDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    }
    if ((bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') && length >= 10) {
      return positiveDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    }
    if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
      for (let index = 2; index + 9 <= length;) {
        if (bytes[index] !== 0xff) { index++; continue; }
        while (index < length && bytes[index] === 0xff) index++;
        const marker = bytes[index++];
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (index + 2 > length) break;
        const size = bytes.readUInt16BE(index);
        if (size < 2 || index + size > length) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return positiveDimensions(bytes.readUInt16BE(index + 5), bytes.readUInt16BE(index + 3));
        }
        index += size;
      }
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && length >= 30) {
      const kind = bytes.subarray(12, 16).toString('ascii');
      if (kind === 'VP8X') return positiveDimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
      if (kind === 'VP8L' && bytes[20] === 0x2f) {
        return positiveDimensions(1 + bytes[21] + ((bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10));
      }
      if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return positiveDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return null;
}

function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !/^[A-Za-z]:[\\/]/.test(rel));
}

function resolveProjectFile(projectDir, declared, type) {
  const candidates = [declared];
  if (type === 'scene') candidates.push('scene.pkg', 'scene.json');
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const filePath = resolve(projectDir, candidate);
    if (isPathInside(projectDir, filePath) && existsSync(filePath)) return filePath;
  }
  return resolve(projectDir, declared);
}

const SUPPORTED_USER_PROPERTY_TYPES = new Set(['bool', 'boolean', 'slider', 'color', 'combo', 'text', 'textinput']);

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneUserPropertyValue(value, fallback = '') {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 4).map(item => finiteNumber(item, 0));
  if (typeof value === 'string') return value.slice(0, 2048);
  return fallback;
}

function normalizeUserPropertyOptions(options) {
  if (Array.isArray(options)) {
    return options.slice(0, 64).flatMap((option, index) => {
      if (typeof option === 'string' || typeof option === 'number') {
        const value = cloneUserPropertyValue(option, String(index));
        return [{ label: String(option), value }];
      }
      if (!option || typeof option !== 'object') return [];
      const value = cloneUserPropertyValue(option.value, String(index));
      const label = typeof option.label === 'string' ? option.label
        : typeof option.text === 'string' ? option.text
          : String(value);
      return [{ label: label.slice(0, 160), value }];
    });
  }
  if (options && typeof options === 'object') {
    return Object.entries(options).slice(0, 64).map(([value, label]) => ({
      label: String(label).slice(0, 160),
      value: cloneUserPropertyValue(value),
    }));
  }
  return [];
}

export function normalizeUserProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.entries(properties).flatMap(([key, definition]) => {
    if (!definition || typeof definition !== 'object') return [];
    const rawType = typeof definition.type === 'string' ? definition.type.toLowerCase() : '';
    if (!SUPPORTED_USER_PROPERTY_TYPES.has(rawType)) return [];
    const type = rawType === 'boolean' ? 'bool' : rawType === 'textinput' ? 'text' : rawType;
    const fallback = type === 'bool' ? false : type === 'slider' ? 0 : '';
    const value = cloneUserPropertyValue(Object.hasOwn(definition, 'value') ? definition.value : fallback, fallback);
    const property = {
      key: String(key),
      label: String(definition.text || definition.label || key).slice(0, 8192),
      type,
      value,
    };
    if (rawType === 'text') property.displayOnly = true;
    if (type === 'slider') {
      property.min = finiteNumber(definition.min, 0);
      property.max = finiteNumber(definition.max, 1);
      if (property.max < property.min) [property.min, property.max] = [property.max, property.min];
      property.step = Math.max(0.0001, finiteNumber(definition.step, (property.max - property.min) / 100 || 1));
      property.value = Math.max(property.min, Math.min(property.max, finiteNumber(value, property.min)));
    }
    if (type === 'combo') property.options = normalizeUserPropertyOptions(definition.options);
    return [property];
  });
}

export function resolveUserPropertyValues(properties, overrides = null) {
  const values = Object.fromEntries((properties || []).map(property => [property.key, cloneUserPropertyValue(property.value, property.type === 'bool' ? false : '')]));
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return values;
  for (const property of properties || []) {
    if (!Object.hasOwn(overrides, property.key)) continue;
    const value = cloneUserPropertyValue(overrides[property.key], values[property.key]);
    if (property.type === 'bool') values[property.key] = value === true;
    else if (property.type === 'slider') values[property.key] = Math.max(property.min, Math.min(property.max, finiteNumber(value, property.value)));
    else if (property.type === 'combo' && property.options?.length) {
      values[property.key] = property.options.some(option => Object.is(option.value, value)) ? value : property.value;
    } else values[property.key] = value;
  }
  return values;
}

export function readProject(projectDir, source = 'local') {
  const projectPath = join(projectDir, 'project.json');
  if (!existsSync(projectPath)) return null;
  try {
    const data = JSON.parse(readFileSync(projectPath, 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.file !== 'string') return null;
    const folderId = basename(projectDir);
    const declaredType = typeof data.type === 'string' ? data.type.toLowerCase() : inferType(data.file);
    const type = declaredType;
    const previewCandidate = typeof data.preview === 'string' ? resolve(projectDir, data.preview) : null;
    const previewPath = previewCandidate && existsSync(previewCandidate) ? previewCandidate : null;
    const filePath = resolveProjectFile(projectDir, data.file, type);
    const portableMediaExists = existsSync(filePath);
    const userProperties = normalizeUserProperties(data.general?.properties);
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : folderId;
    const imageProject = IMAGE_FILE.test(data.file) && portableMediaExists;
    const dimensions = imageProject ? readImageDimensions(filePath) : null;
    const imagePreviewPath = previewPath || (imageProject ? filePath : null);
    return {
      id: source === 'workshop' ? folderId : `${source}:${folderId}`,
      source,
      title,
      type: ['scene', 'video', 'web', 'application'].includes(type) ? type : 'scene',
      projectPath,
      projectDir,
      filePath,
      previewPath: imagePreviewPath,
      userProperties,
      isStatic: (STATIC_IMAGE_FILE.test(data.file) && portableMediaExists) || STATIC_TITLE.test(title),
      sourceWidth: dimensions?.width ?? null,
      sourceHeight: dimensions?.height ?? null,
      skinMode: type === 'video' && portableMediaExists
        ? 'video'
        : type === 'web' && portableMediaExists
          ? 'web'
          : type === 'scene' && portableMediaExists && filePath.toLowerCase().endsWith('.pkg')
            ? 'scene'
          : imagePreviewPath
            ? 'preview'
            : 'unsupported',
    };
  } catch {
    return null;
  }
}

export function enumerateWallpaperSources(info = wallpaperEngineSourceInfo()) {
  const roots = [];
  if (info.installDir) {
    roots.push({ path: join(info.installDir, 'projects', 'defaultprojects'), source: 'default' });
    roots.push({ path: join(info.installDir, 'projects', 'myprojects'), source: 'local' });
  }
  for (const library of info.libraryDirs || []) {
    roots.push({ path: join(library, 'steamapps', 'workshop', 'content', WE_APP_ID), source: 'workshop' });
  }

  const found = new Map();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    let entries;
    try { entries = readdirSync(root.path); } catch { continue; }
    for (const entry of entries) {
      const projectDir = join(root.path, entry);
      let stat;
      try { stat = statSync(projectDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const project = readProject(projectDir, root.source);
      if (!project) continue;
      const key = normalize(project.projectPath).toLowerCase();
      if (!found.has(key)) found.set(key, project);
    }
  }
  return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function wallpaperSourceStatus() {
  const info = wallpaperEngineSourceInfo();
  const sources = info.installed ? enumerateWallpaperSources(info) : [];
  return {
    platform: process.platform,
    installed: info.installed,
    installDir: info.installDir,
    sourceCount: sources.length,
    usableAsCodexSkin: sources.filter((item) => item.skinMode !== 'unsupported').length,
    countsByMode: Object.fromEntries(
      ['video', 'web', 'scene', 'preview', 'unsupported'].map((mode) => [mode, sources.filter((item) => item.skinMode === mode).length]),
    ),
  };
}
