import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { AssemblyConfig } from '../assembly/config';
import { resolveKit, resolvePlugin } from '../plugin/resolver';
import type { ApplicationDiagnostic, ApplicationPluginSpec } from './types';

interface DiscoverApplicationPluginsOptions {
  assembly: AssemblyConfig;
  selectedKit?: string;
}

interface KitStartupDeclaration {
  name: string;
  path: string;
  startupPlugins: string[];
}

export async function discoverApplicationPlugins(
  options: DiscoverApplicationPluginsOptions,
): Promise<{ plugins: ApplicationPluginSpec[]; diagnostics: ApplicationDiagnostic[] }> {
  const diagnostics: ApplicationDiagnostic[] = [];
  const kitPaths = options.selectedKit
    ? [await resolveKit(options.selectedKit, options.assembly)]
    : await discoverKitPaths(options.assembly);
  const declarations: KitStartupDeclaration[] = [];

  for (const kitPath of kitPaths) {
    const declaration = await readKitDeclaration(kitPath, diagnostics);
    if (declaration) declarations.push(declaration);
  }

  const plugins: ApplicationPluginSpec[] = [];
  const byName = new Map<string, ApplicationPluginSpec>();
  const conflicted = new Set<string>();

  for (const declaration of declarations) {
    for (const pluginName of declaration.startupPlugins) {
      let pluginPath: string;
      try {
        pluginPath = await resolvePlugin(pluginName, {
          builtinPluginsDir: options.assembly.builtinPluginsDir,
          pluginsDir: options.assembly.pluginsDir,
          activeKitPluginsDir: path.join(declaration.path, 'plugins'),
        });
      } catch (error) {
        diagnostics.push({
          code: 'PLUGIN_RESOLUTION_FAILED',
          kit: declaration.name,
          plugin: pluginName,
          message: errorMessage(error),
        });
        continue;
      }

      if (conflicted.has(pluginName)) continue;
      const existing = byName.get(pluginName);
      if (!existing) {
        const spec = { name: pluginName, path: pluginPath, kits: [declaration.name] };
        byName.set(pluginName, spec);
        plugins.push(spec);
        continue;
      }
      if (existing.path === pluginPath) {
        if (!existing.kits.includes(declaration.name)) existing.kits.push(declaration.name);
        continue;
      }

      conflicted.add(pluginName);
      byName.delete(pluginName);
      plugins.splice(plugins.indexOf(existing), 1);
      diagnostics.push({
        code: 'PLUGIN_PATH_CONFLICT',
        plugin: pluginName,
        message: `Startup plugin "${pluginName}" resolves to different paths: ${existing.path} and ${pluginPath}`,
      });
    }
  }

  return { plugins, diagnostics };
}

async function discoverKitPaths(assembly: AssemblyConfig): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const kitsDir of [assembly.builtinKitsDir, assembly.kitsDir]) {
    let entries;
    try {
      entries = await readdir(kitsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const canonical = await realpath(path.join(kitsDir, entry.name));
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

async function readKitDeclaration(
  kitPath: string,
  diagnostics: ApplicationDiagnostic[],
): Promise<KitStartupDeclaration | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(kitPath, 'package.json'), 'utf8'));
  } catch (error) {
    diagnostics.push({
      code: 'INVALID_KIT_MANIFEST',
      message: `Invalid Kit manifest at ${kitPath}: ${errorMessage(error)}`,
    });
    return undefined;
  }
  const name = isRecord(manifest) ? manifest.name : undefined;
  const editorConfig = isRecord(manifest) ? manifest['ce-editor'] : undefined;
  const kit = isRecord(editorConfig) ? editorConfig.kit : undefined;
  if (typeof name !== 'string' || !isRecord(kit)) {
    diagnostics.push({
      code: 'INVALID_KIT_MANIFEST',
      message: `Kit at ${kitPath} must define name and ce-editor.kit`,
    });
    return undefined;
  }
  const startup = kit.startup;
  const startupPlugins = isRecord(startup) ? startup.plugins : undefined;
  if (startupPlugins === undefined) {
    return { name, path: kitPath, startupPlugins: [] };
  }
  if (!isStringArray(startupPlugins) || new Set(startupPlugins).size !== startupPlugins.length) {
    diagnostics.push({
      code: 'INVALID_STARTUP_PLUGINS',
      kit: name,
      message: `Kit "${name}" startup.plugins must contain unique non-empty strings`,
    });
    return undefined;
  }
  const ordinaryPlugins = kit.plugin;
  if (ordinaryPlugins !== undefined && !isStringArray(ordinaryPlugins)) {
    diagnostics.push({
      code: 'INVALID_KIT_MANIFEST',
      kit: name,
      message: `Kit "${name}" plugin must contain non-empty strings`,
    });
    return undefined;
  }
  const ordinary = new Set(ordinaryPlugins ?? []);
  const overlap = startupPlugins.find((pluginName) => ordinary.has(pluginName));
  if (overlap) {
    diagnostics.push({
      code: 'STARTUP_PLUGIN_OVERLAP',
      kit: name,
      plugin: overlap,
      message: `Kit "${name}" declares "${overlap}" as both startup and ordinary plugin`,
    });
    return undefined;
  }
  return { name, path: kitPath, startupPlugins };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
