import { build as esbuild } from 'esbuild';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_KITS } from './builtin-kits.mjs';

const BUILTIN_KIT_SLUGS = new Set(BUILTIN_KITS.map(({ slug }) => slug));
const FRAMEWORK_PLUGINS = Object.freeze(['config', 'menu', 'message', 'panel']);

const DESKTOP_ASSETS = Object.freeze([
  ...[
    'electron-preload.cjs',
    'notification-preload.cjs',
    'kit-manager-preload.cjs',
    'kit-manager-renderer.mjs',
    'kit-manager.css',
    'kit-manager.html',
  ].map((filename) => Object.freeze({
    source: `scripts/${filename}`,
    destination: filename,
  })),
  Object.freeze({
    source: 'scripts/assets/tray-icon.png',
    destination: 'assets/tray-icon.png',
  }),
  Object.freeze({
    source: 'scripts/assets/tray-icon@2x.png',
    destination: 'assets/tray-icon@2x.png',
  }),
]);

async function runtimeEntries(repositoryRoot) {
  const entries = [
    { source: 'packages/client/dist', destination: 'client', recursive: true },
    {
      source: '.agents/skills/notify-user/SKILL.md',
      destination: 'resources/notify-user/SKILL.md',
    },
    {
      source: '.agents/skills/notify-user/agents/openai.yaml',
      destination: 'resources/notify-user/agents/openai.yaml',
    },
    {
      source: '.agents/skills/notify-user/scripts/notify.mjs',
      destination: 'resources/notify-user/scripts/notify.mjs',
    },
  ];
  for (const plugin of FRAMEWORK_PLUGINS) {
    entries.push(
      {
        source: `plugins/${plugin}/package.json`,
        destination: `plugins/${plugin}/package.json`,
      },
      {
        source: `plugins/${plugin}/main/dist`,
        destination: `plugins/${plugin}/main/dist`,
        recursive: true,
      },
    );
  }
  entries.push(...await builtinKitEntries(repositoryRoot));
  return entries;
}

function inside(parent, candidate) {
  return candidate !== parent && candidate.startsWith(`${parent}${path.sep}`);
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function portableIdentity(relative) {
  return portable(relative).normalize('NFC').toLowerCase();
}

function validateRelative(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || path.isAbsolute(value)
    || value.includes('\\')
    || value.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(label === 'Desktop source'
      ? 'Desktop source is outside the repository'
      : 'Desktop destination is outside its output root');
  }
  return value;
}

function rejectNonBuiltinKit(relative) {
  const parts = portable(relative).split('/');
  if (portableIdentity(parts[0] ?? '') !== 'kits') return;
  if (parts[0] !== 'kits') throw new Error(`Desktop source spelling alias is not portable: ${relative}`);
  if (!parts[1]) return;
  const builtinSlug = [...BUILTIN_KIT_SLUGS]
    .find((slug) => portableIdentity(slug) === portableIdentity(parts[1]));
  if (!builtinSlug) throw new Error(`Desktop runtime cannot include product Kit ${parts[1]}`);
  if (parts[1] !== builtinSlug) {
    throw new Error(`Desktop source spelling alias is not portable: ${relative}`);
  }
}

async function checkedPath(repositoryRoot, source) {
  validateRelative(source, 'Desktop source');
  rejectNonBuiltinKit(source);
  const absolute = path.resolve(repositoryRoot, source);
  if (!inside(repositoryRoot, absolute)) throw new Error('Desktop source is outside the repository');
  let current = repositoryRoot;
  for (const part of path.relative(repositoryRoot, absolute).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new Error(`Desktop source is missing or not a regular file: ${source}`);
    if (info.isSymbolicLink()) throw new Error(`Desktop source must not contain a symbolic link: ${source}`);
  }
  return absolute;
}

async function checkedFile(repositoryRoot, source) {
  const absolute = await checkedPath(repositoryRoot, source);
  if (!(await lstat(absolute)).isFile()) {
    throw new Error(`Desktop source is missing or not a regular file: ${source}`);
  }
  return absolute;
}

function manifestRelativePath(entry, label) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\\') || path.posix.isAbsolute(entry)) {
    throw new Error(`${label} must be a portable relative path`);
  }
  const normalized = entry.startsWith('./') ? entry.slice(2) : entry;
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`${label} must be a portable relative path`);
  }
  return normalized;
}

function builtDirectory(entry, kind) {
  const label = `Desktop plugin ${kind} entrypoint`;
  let normalized;
  try {
    normalized = manifestRelativePath(entry, label);
  } catch {
    throw new Error(`${label} must name a built artifact beneath dist`);
  }
  const parts = normalized.split('/');
  const directory = path.posix.dirname(normalized);
  const directoryParts = directory.split('/').filter((part) => part !== '.');
  if (!directoryParts.includes('dist') || directoryParts.includes('src')) {
    throw new Error(`${label} must name a built artifact beneath dist`);
  }
  const filename = parts.at(-1);
  if (kind === 'main' && !['.js', '.mjs', '.cjs'].includes(path.posix.extname(filename))) {
    throw new Error(`${label} must name a .js, .mjs, or .cjs artifact beneath dist`);
  }
  if (kind === 'panel' && (filename !== 'index.html' || parts.at(-2) !== 'dist')) {
    throw new Error(`${label} must name an index.html artifact beneath dist`);
  }
  return { directory, normalized };
}

async function builtDirectoryEntry(repositoryRoot, pluginRoot, entry, kind) {
  const { directory, normalized } = builtDirectory(entry, kind);
  await checkedFile(repositoryRoot, `${pluginRoot}/${normalized}`);
  const source = `${pluginRoot}/${directory}`;
  return { source, destination: source, recursive: true };
}

function requireStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique non-empty strings`);
  }
  return [...value];
}

function readKitPluginNames(kit, label) {
  const ordinary = requireStringArray(kit.plugin, `${label} plugin`);
  const startup = kit.startup;
  if (startup !== undefined && (!startup || typeof startup !== 'object' || Array.isArray(startup))) {
    throw new Error(`${label} startup must be an object`);
  }
  const startupPlugins = requireStringArray(startup?.plugins, `${label} startup.plugins`);
  const ordinaryNames = new Set(ordinary);
  const overlap = startupPlugins.find((name) => ordinaryNames.has(name));
  if (overlap) throw new Error(`${label} plugin ${overlap} is declared as ordinary and startup`);
  return [...ordinary, ...startupPlugins];
}

async function readJsonManifest(filename, label) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function kitPayloadEntries(repositoryRoot, slug, kit) {
  const label = `Desktop builtin Kit ${slug}`;
  const layouts = kit?.layouts;
  if (!layouts || typeof layouts !== 'object' || Array.isArray(layouts)
    || typeof layouts.default !== 'string' || layouts.default.length === 0) {
    throw new Error(`${label} layouts.default must be a non-empty path`);
  }
  const layoutEntries = Object.entries(layouts);
  if (layoutEntries.some(([, entry]) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} layouts must contain non-empty paths`);
  }
  const windows = kit.windowEntries;
  for (const kind of ['main', 'secondary']) {
    if (!windows || typeof windows !== 'object' || Array.isArray(windows)
      || typeof windows[kind] !== 'string' || windows[kind].length === 0) {
      throw new Error(`${label} windowEntries.${kind} must be a non-empty path`);
    }
  }
  const kitRoot = `kits/${slug}`;
  const declaredFiles = [
    ...layoutEntries.map(([name, entry]) => ({ entry, label: `${label} layout ${name}` })),
    ...['main', 'secondary'].map((kind) => ({
      entry: windows[kind],
      label: `${label} windowEntries.${kind}`,
    })),
  ];
  const entries = [];
  const seen = new Set();
  for (const declared of declaredFiles) {
    const relative = manifestRelativePath(declared.entry, declared.label);
    const source = `${kitRoot}/${relative}`;
    if (seen.has(source)) continue;
    seen.add(source);
    await checkedFile(repositoryRoot, source);
    entries.push({ source, destination: source });
  }
  return entries;
}

async function pluginPublicEntries(repositoryRoot, pluginRoot, manifest) {
  const assets = manifest?.['ce-editor']?.assets;
  if (assets === undefined) return [];
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)
    || (assets.public !== undefined && !Array.isArray(assets.public))
    || assets.public?.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`Desktop plugin public asset roots are malformed for ${manifest?.name ?? pluginRoot}`);
  }
  if (assets.public === undefined) return [];
  const entries = [];
  for (const declared of assets.public) {
    const relative = manifestRelativePath(declared, 'Desktop plugin public asset root');
    if (relative === '.' || relative.split('/').includes('src')) {
      throw new Error(`Desktop plugin public asset root must not include source trees: ${declared}`);
    }
    const source = `${pluginRoot}/${relative}`;
    let directory;
    try {
      directory = await checkedPath(repositoryRoot, source);
    } catch (error) {
      throw new Error(`Desktop plugin public asset root is invalid: ${error.message}`);
    }
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`Desktop plugin public asset root must be a directory: ${declared}`);
    }
    entries.push({ source, destination: source, recursive: true });
  }
  return entries;
}

async function builtinKitPluginEntries(repositoryRoot, slug, declaredPluginNames) {
  const entries = [];
  const pluginsRoot = `kits/${slug}/plugins`;
  const pluginsDirectory = await checkedPath(repositoryRoot, pluginsRoot);
  const pluginDirectories = (await readdir(pluginsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const byName = new Map();
  for (const plugin of pluginDirectories) {
    const pluginRoot = `${pluginsRoot}/${plugin}`;
    const packageSource = `${pluginRoot}/package.json`;
    const packageFile = await checkedFile(repositoryRoot, packageSource);
    const manifest = await readJsonManifest(packageFile, `Desktop builtin plugin ${plugin}`);
    if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`Desktop builtin plugin ${plugin} must declare a package name`);
    }
    if (byName.has(manifest.name)) {
      throw new Error(`Desktop builtin Kit ${slug} has duplicate plugin package ${manifest.name}`);
    }
    byName.set(manifest.name, { pluginRoot, packageSource, manifest });
  }
  const declared = new Set(declaredPluginNames);
  for (const name of byName.keys()) {
    if (!declared.has(name)) throw new Error(`Desktop builtin Kit ${slug} has undeclared plugin ${name}`);
  }
  for (const name of declaredPluginNames) {
    const plugin = byName.get(name);
    if (!plugin) throw new Error(`Desktop builtin Kit ${slug} is missing declared plugin ${name}`);
    const { pluginRoot, packageSource, manifest } = plugin;
    const panels = manifest?.['ce-editor']?.contribute?.panel;
    if (panels !== undefined && (!panels || typeof panels !== 'object' || Array.isArray(panels))) {
      throw new Error(`Desktop plugin panel contributions are malformed for ${name}`);
    }
    const panelEntries = Object.entries(panels ?? {})
      .map(([panelName, panel]) => {
        if (!panel || typeof panel !== 'object' || Array.isArray(panel)) {
          throw new Error(`Desktop plugin panel ${panelName} is malformed for ${name}`);
        }
        return panel.entry;
      })
      .sort((left, right) => String(left).localeCompare(String(right)));
    entries.push({ source: packageSource, destination: packageSource });
    entries.push(await builtDirectoryEntry(repositoryRoot, pluginRoot, manifest.main, 'main'));
    for (const entry of panelEntries) {
      entries.push(await builtDirectoryEntry(repositoryRoot, pluginRoot, entry, 'panel'));
    }
    entries.push(...await pluginPublicEntries(repositoryRoot, pluginRoot, manifest));
  }
  return entries;
}

async function builtinKitEntries(repositoryRoot) {
  const entries = [];
  for (const { slug } of BUILTIN_KITS) {
    const packageSource = `kits/${slug}/package.json`;
    const packageFile = await checkedFile(repositoryRoot, packageSource);
    const manifest = await readJsonManifest(packageFile, `Desktop builtin Kit ${slug} package.json`);
    const kit = manifest?.['ce-editor']?.kit;
    if (!kit || typeof kit !== 'object' || Array.isArray(kit)) {
      throw new Error(`Desktop builtin Kit ${slug} must declare ce-editor.kit`);
    }
    const pluginNames = readKitPluginNames(kit, `Desktop builtin Kit ${slug}`);
    entries.push({ source: packageSource, destination: packageSource });
    entries.push(...await kitPayloadEntries(repositoryRoot, slug, kit));
    entries.push(...await builtinKitPluginEntries(repositoryRoot, slug, pluginNames));
  }
  return entries;
}

async function expandTree(repositoryRoot, sourceRoot, destinationRoot, files) {
  const names = await readdir(sourceRoot);
  for (const name of names.sort()) {
    const source = path.join(sourceRoot, name);
    const destination = path.join(destinationRoot, name);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      throw new Error(`Desktop source must not contain a symbolic link: ${portable(source)}`);
    }
    if (info.isDirectory()) {
      await expandTree(repositoryRoot, source, destination, files);
    } else if (info.isFile()) {
      const canonical = await realpath(source);
      if (!inside(repositoryRoot, canonical)) throw new Error('Desktop source is outside the repository');
      files.push({ source: canonical, destination });
    } else {
      throw new Error(`Desktop source must contain only regular files and directories: ${portable(source)}`);
    }
  }
}

async function createCopyPlan({ repositoryRoot, outputRoot, entries }) {
  if (!Array.isArray(entries)) throw new TypeError('Desktop copy entries must be an array');
  const files = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Desktop copy entry must be an object');
    }
    const sourceRelative = validateRelative(entry.source, 'Desktop source');
    const destinationRelative = validateRelative(entry.destination, 'Desktop destination');
    rejectNonBuiltinKit(sourceRelative);
    const source = await checkedPath(repositoryRoot, sourceRelative);
    const destination = path.resolve(outputRoot, destinationRelative);
    if (!inside(outputRoot, destination)) throw new Error('Desktop destination is outside its output root');
    const info = await lstat(source);
    if (entry.recursive === true) {
      if (!info.isDirectory()) throw new Error(`Desktop recursive source must be a directory: ${sourceRelative}`);
      await expandTree(repositoryRoot, source, destination, files);
    } else {
      if (!info.isFile()) throw new Error(`Desktop source is missing or not a regular file: ${sourceRelative}`);
      const canonical = await realpath(source);
      if (!inside(repositoryRoot, canonical)) throw new Error('Desktop source is outside the repository');
      files.push({ source: canonical, destination });
    }
  }
  files.sort((left, right) => (
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0
  ));
  const destinations = [];
  for (const file of files) {
    const relative = portable(path.relative(outputRoot, file.destination));
    const identity = portableIdentity(relative);
    if (destinations.some((existing) => (
      existing === identity
      || existing.startsWith(`${identity}/`)
      || identity.startsWith(`${existing}/`)
    ))) {
      throw new Error(`Desktop copy contains duplicate destination collision ${relative}`);
    }
    destinations.push(identity);
  }
  return files;
}

async function copyPlan(outputRoot, files) {
  for (const file of files) {
    await mkdir(path.dirname(file.destination), { recursive: true });
    await copyFile(file.source, file.destination);
  }
  return Object.freeze(files.map((file) => portable(path.relative(outputRoot, file.destination))));
}

async function canonicalRoots(repositoryRoot, outputRoot) {
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(outputRoot)) {
    throw new TypeError('Desktop repository and output roots must be absolute');
  }
  const requestedRoot = path.resolve(repositoryRoot);
  const requestedOutput = path.resolve(outputRoot);
  if (!inside(requestedRoot, requestedOutput)) {
    throw new Error('Desktop output must remain inside the repository');
  }
  const root = await realpath(requestedRoot);
  const output = path.resolve(root, path.relative(requestedRoot, requestedOutput));
  let current = root;
  for (const part of path.relative(root, output).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error('Desktop output must not contain a symbolic link');
    if (!info.isDirectory()) throw new Error('Desktop output path must contain only directories');
  }
  return { root, output };
}

export async function stageDesktopFiles({ repositoryRoot, outputRoot, entries }) {
  const { root, output } = await canonicalRoots(repositoryRoot, outputRoot);
  const files = await createCopyPlan({ repositoryRoot: root, outputRoot: output, entries });
  await mkdir(output, { recursive: true });
  return copyPlan(output, files);
}

export async function buildDesktop({ repositoryRoot, outputRoot }) {
  const { root, output } = await canonicalRoots(repositoryRoot, outputRoot);
  const distRoot = path.join(root, 'dist');
  if (!inside(distRoot, output)) {
    throw new Error('Desktop runtime output must be a child of the repository dist directory');
  }
  const desktopDist = path.join(root, 'packages', 'desktop', 'dist');
  if (inside(desktopDist, output) || inside(output, desktopDist) || output === desktopDist) {
    throw new Error('Desktop bundle and runtime output directories must not overlap');
  }
  const mainEntry = await checkedFile(root, 'scripts/electron.mjs');
  const frameworkEntry = await checkedFile(root, 'packages/desktop/src/framework.mjs');
  const desktopFiles = await createCopyPlan({
    repositoryRoot: root,
    outputRoot: desktopDist,
    entries: DESKTOP_ASSETS,
  });
  const runtimeFiles = await createCopyPlan({
    repositoryRoot: root,
    outputRoot: output,
    entries: await runtimeEntries(root),
  });

  await rm(desktopDist, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(desktopDist, { recursive: true });
  await esbuild({
    entryPoints: [mainEntry],
    outfile: path.join(desktopDist, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron', 'electron-updater', 'better-sqlite3', 'sigstore', 'snappyjs', 'yauzl'],
  });
  await esbuild({
    entryPoints: [frameworkEntry],
    outfile: path.join(desktopDist, 'framework.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['better-sqlite3'],
  });
  await copyPlan(desktopDist, desktopFiles);
  const inventory = await copyPlan(output, runtimeFiles);
  return Object.freeze({ outputRoot: output, inventory });
}
