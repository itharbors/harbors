import path from 'node:path';

export interface AssemblyConfig {
  builtinPluginsDir: string;
  pluginsDir: string;
  builtinKitsDir: string;
  kitsDir: string;
  defaultKit: string;
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
    defaultKit: override.defaultKit ?? fileConfig.defaultKit,
  };
}
