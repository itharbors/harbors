import { readFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export interface PluginResolveContext {
  builtinPluginsDir: string;
  pluginsDir: string;
  activeKitPluginsDir: string | null;
}

export interface KitResolveContext {
  builtinKitsDir: string;
  kitsDir: string;
}

/**
 * Resolve a plugin to its on-disk directory path.
 *
 * Looks up the plugin by package name `<name>` only in the explicit assembly
 * directories supplied by the caller.
 *
 * @param name     The npm-style package name of the plugin (e.g. `@scope/foo`).
 * @param ctx      Explicit plugin resolution directories.
 * @returns The resolved absolute path to the plugin directory.
 * @throws If the plugin cannot be found in the configured directories.
 */
export async function resolvePlugin(name: string, ctx: PluginResolveContext): Promise<string> {
  for (const pluginsDir of [ctx.builtinPluginsDir, ctx.pluginsDir, ctx.activeKitPluginsDir].filter(Boolean) as string[]) {
    const resolved = await findPluginInDir(name, pluginsDir);
    if (resolved) return resolved;
  }

  throw new Error(`Plugin "${name}" not found`);
}

export async function resolveKit(nameOrPath: string, ctx: KitResolveContext): Promise<string> {
  if (isPathLike(nameOrPath)) {
    const explicitPath = path.resolve(nameOrPath);
    if (fs.existsSync(path.join(explicitPath, 'package.json'))) {
      return explicitPath;
    }
  }

  for (const kitsDir of [ctx.builtinKitsDir, ctx.kitsDir]) {
    let entries: string[] = [];
    try {
      entries = await readdir(kitsDir);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw err;
      }
      continue;
    }

    for (const entry of entries) {
      const kitDir = path.join(kitsDir, entry);
      const pkgPath = path.join(kitDir, 'package.json');
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
        if ((entry === nameOrPath || pkg.name === nameOrPath) && pkg['ce-editor']?.kit) {
          return kitDir;
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Kit "${nameOrPath}" not found`);
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\');
}

async function findPluginInDir(name: string, pluginsDir: string): Promise<string | undefined> {
  let entries: string[] = [];
  try {
    entries = await readdir(pluginsDir);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw err;
    }
    return undefined;
  }

  for (const entry of entries) {
    const pkgPath = path.join(pluginsDir, entry, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.name === name && pkg['ce-editor']) {
        return fs.promises.realpath(path.join(pluginsDir, entry));
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
