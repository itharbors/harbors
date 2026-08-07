import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseRepositoryKitPackage } from '@itharbors/kit-core';

export interface AssemblyConfig {
  builtinPluginsDir: string;
  pluginsDir: string;
  builtinKitsDir: string;
  kitsDir: string;
  kitSources: AssemblyKitSource[];
  defaultKit: string;
}

export type KitSourceKind = 'builtin' | 'installed' | 'development' | 'explicit';

export interface AssemblyKitSource {
  directory: string;
  source: KitSourceKind;
  artifactSha256?: string;
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
    kitSources: [],
    defaultKit: '',
  }, override);
}

export function resolveDefaultKitFromSources(sources: AssemblyKitSource[]): string {
  const builtinSources = sources.filter((source) => source.source === 'builtin');
  const defaults = builtinSources.flatMap((source) => {
    try {
      const packageJson = JSON.parse(readFileSync(path.join(source.directory, 'package.json'), 'utf8'));
      const metadata = parseRepositoryKitPackage(packageJson.harbors);
      if (metadata.distribution !== 'builtin') {
        throw new Error('builtin Assembly source must declare builtin distribution');
      }
      if (typeof packageJson.name !== 'string'
        || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageJson.name)) {
        throw new Error('builtin Assembly source package name must be canonical');
      }
      return metadata.isDefault === true ? [packageJson.name] : [];
    } catch (error) {
      throw new Error(`Cannot resolve default Kit descriptor from ${source.directory}`, { cause: error });
    }
  });
  if (defaults.length !== 1) {
    throw new Error('Kit sources must contain exactly one builtin default descriptor');
  }
  return defaults[0];
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
    kitSources: cloneKitSources(override.kitSources ?? fileConfig.kitSources),
    defaultKit: override.defaultKit ?? fileConfig.defaultKit,
  };
}

function cloneKitSources(value: AssemblyKitSource[]): AssemblyKitSource[] {
  return value.map((item) => ({
    directory: path.resolve(item.directory),
    source: item.source,
    ...(item.artifactSha256 ? { artifactSha256: item.artifactSha256 } : {}),
  }));
}
