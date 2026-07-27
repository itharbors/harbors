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
    ...BUILTIN_KITS.flatMap(({ slug }) => [
      { source: `kits/${slug}/package.json`, destination: `kits/${slug}/package.json` },
      { source: `kits/${slug}/layout.json`, destination: `kits/${slug}/layout.json` },
      { source: `kits/${slug}/main.html`, destination: `kits/${slug}/main.html` },
      { source: `kits/${slug}/secondary.html`, destination: `kits/${slug}/secondary.html` },
    ]),
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
  entries.push(...await builtinKitPluginEntries(repositoryRoot));
  return entries;
}

function inside(parent, candidate) {
  return candidate !== parent && candidate.startsWith(`${parent}${path.sep}`);
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function validateRelative(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || path.isAbsolute(value)
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
  if (parts[0] === 'kits' && parts[1] && !BUILTIN_KIT_SLUGS.has(parts[1])) {
    throw new Error(`Desktop runtime cannot include product Kit ${parts[1]}`);
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

function builtDirectory(entry) {
  if (typeof entry !== 'string') return entry;
  if (path.posix.isAbsolute(entry)) return entry;
  const directory = path.posix.dirname(entry);
  return directory === '.' ? entry : directory;
}

function builtDirectoryEntry(pluginRoot, entry) {
  const directory = builtDirectory(entry);
  const source = typeof directory === 'string' && path.posix.isAbsolute(directory)
    ? directory
    : typeof directory === 'string'
      ? `${pluginRoot}/${directory}`
      : directory;
  return { source, destination: source, recursive: true };
}

async function builtinKitPluginEntries(repositoryRoot) {
  const entries = [];
  for (const { slug } of BUILTIN_KITS) {
    const pluginsRoot = `kits/${slug}/plugins`;
    const pluginsDirectory = await checkedPath(repositoryRoot, pluginsRoot);
    const plugins = (await readdir(pluginsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const plugin of plugins) {
      const pluginRoot = `${pluginsRoot}/${plugin}`;
      const packageSource = `${pluginRoot}/package.json`;
      const packageFile = await checkedFile(repositoryRoot, packageSource);
      const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
      const panels = manifest?.['ce-editor']?.contribute?.panel;
      const entriesToStage = [
        manifest?.main,
        ...Object.values(panels ?? {}).map((panel) => panel?.entry),
      ].sort((left, right) => String(left).localeCompare(String(right)));
      entries.push(
        { source: packageSource, destination: packageSource },
        ...entriesToStage.map((entry) => builtDirectoryEntry(pluginRoot, entry)),
      );
    }
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
  const destinations = new Set();
  for (const file of files) {
    const relative = portable(path.relative(outputRoot, file.destination));
    if (destinations.has(relative)) throw new Error(`Desktop copy contains duplicate destination ${relative}`);
    destinations.add(relative);
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
