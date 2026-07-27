import path from 'node:path';

export interface AssemblyConfig {
  builtinPluginsDir: string;
  pluginsDir: string;
  builtinKitsDir: string;
  kitsDir: string;
  installedKitDirs: string[];
  kitSources?: AssemblyKitSource[] | null;
  defaultKit: string;
}

export type KitSourceKind = 'builtin' | 'installed' | 'development' | 'explicit';

export interface AssemblyKitSource {
  directory: string;
  source: KitSourceKind;
}

export interface AssemblyConfigOverride extends Partial<AssemblyConfig> {}

export function createDefaultAssemblyConfig(
  projectRoot: string,
  override: AssemblyConfigOverride = {},
): AssemblyConfig {
  return normalizeAssemblyConfig({
    builtinPluginsDir: path.join(projectRoot, 'plugins'),
    pluginsDir: path.join(projectRoot, 'plugins'),
    builtinKitsDir: path.join(projectRoot, 'kits'),
    kitsDir: path.join(projectRoot, 'kits'),
    installedKitDirs: [],
    kitSources: null,
    defaultKit: '@itharbors/kit-default',
  }, override);
}

export function normalizeAssemblyConfig(
  fileConfig: AssemblyConfig,
  override: AssemblyConfigOverride = {},
): AssemblyConfig {
  return {
    builtinPluginsDir: override.builtinPluginsDir ?? fileConfig.builtinPluginsDir,
    pluginsDir: override.pluginsDir ?? fileConfig.pluginsDir,
    builtinKitsDir: override.builtinKitsDir ?? fileConfig.builtinKitsDir,
    kitsDir: override.kitsDir ?? fileConfig.kitsDir,
    installedKitDirs: [...(override.installedKitDirs ?? fileConfig.installedKitDirs ?? [])],
    kitSources: cloneKitSources(override.kitSources ?? fileConfig.kitSources ?? null),
    defaultKit: override.defaultKit ?? fileConfig.defaultKit,
  };
}

function cloneKitSources(value: AssemblyKitSource[] | null): AssemblyKitSource[] | null {
  return value === null ? null : value.map((item) => ({
    directory: path.resolve(item.directory),
    source: item.source,
  }));
}
