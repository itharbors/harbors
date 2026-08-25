import type { KitPackageManifest, KitPermission, KitTarget } from './model.js';

export const SUPPORTED_KIT_RUNNERS = ['macos-14', 'ubuntu-latest'] as const;

export type SupportedRunner = (typeof SUPPORTED_KIT_RUNNERS)[number];
export type KitDistribution = 'builtin' | 'market';

export interface RepositoryKitScripts {
  readonly build: string;
  readonly test: string;
  readonly smoke?: string;
}

export interface RepositoryKitPackageMetadata {
  readonly distribution: KitDistribution;
  readonly isDefault: boolean;
  readonly ciRunner: SupportedRunner;
  readonly summary: string;
  readonly scripts: RepositoryKitScripts;
  readonly resources: readonly string[];
  readonly legacyDataDirectories: readonly string[];
  readonly legacyPluginDataDirectories: Readonly<Record<string, readonly string[]>>;
}

export interface RepositoryKitDescriptor {
  readonly slug: string;
  readonly directory: string;
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly menuRoot: Readonly<{ id: string; label: string }>;
  readonly distribution: KitDistribution;
  readonly isDefault: boolean;
  readonly target: KitTarget;
  readonly permissions: readonly KitPermission[];
  readonly ciRunner: SupportedRunner;
  readonly summary: string;
  readonly scripts: RepositoryKitScripts;
  readonly resources: readonly string[];
  readonly legacyDataDirectories: readonly string[];
  readonly legacyPluginDataDirectories: Readonly<Record<string, readonly string[]>>;
  readonly manifest: KitPackageManifest;
  readonly packageJson: Readonly<Record<string, unknown>>;
}

type UnknownRecord = Record<string, unknown>;
const PLUGIN_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function record(value: unknown, context: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  context: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new Error(`${context} contains unexpected field ${unknown}`);
  }
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${context} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseResources(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('harbors.resources must be an array');
  }
  const resources = value.map((resource, index) => {
    const parsed = stringValue(resource, `harbors.resources[${index}]`);
    if (parsed.includes('\\') || parsed.includes('\0') || parsed.startsWith('/')) {
      throw new Error(`harbors.resources[${index}] must be a Kit-relative path`);
    }
    const segments = parsed.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`harbors.resources[${index}] must be a normalized Kit-relative path`);
    }
    return parsed;
  });
  if (new Set(resources).size !== resources.length) {
    throw new Error('harbors.resources contains duplicate values');
  }
  return resources;
}

function parseLegacyDirectoryArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const directories = value.map((directory, index) => {
    const parsed = stringValue(directory, `${context}[${index}]`);
    if (
      parsed.includes('/')
      || parsed.includes('\\')
      || parsed.includes('\0')
      || parsed === '.'
      || parsed === '..'
      || parsed.startsWith('/')
    ) {
      throw new Error(
        `${context}[${index}] must be a single canonical directory name`,
      );
    }
    return parsed;
  });
  if (new Set(directories).size !== directories.length) {
    throw new Error(`${context} contains duplicate values`);
  }
  return directories;
}

function parseStorage(value: unknown): {
  legacyDataDirectories: readonly string[];
  legacyPluginDataDirectories: Readonly<Record<string, readonly string[]>>;
} {
  const input = record(value, 'harbors.storage');
  exactKeys(input, ['legacyDataDirectories', 'legacyPluginDataDirectories'], 'harbors.storage');
  const legacyDataDirectories = input.legacyDataDirectories === undefined
    ? []
    : parseLegacyDirectoryArray(input.legacyDataDirectories, 'harbors.storage.legacyDataDirectories');
  const pluginInput = input.legacyPluginDataDirectories === undefined
    ? {}
    : record(input.legacyPluginDataDirectories, 'harbors.storage.legacyPluginDataDirectories');
  const legacyPluginDataDirectories = Object.freeze(Object.fromEntries(
    Object.entries(pluginInput).map(([pluginName, directories]) => {
      if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
        throw new Error('harbors.storage.legacyPluginDataDirectories contains invalid Plugin owner');
      }
      return [pluginName, Object.freeze(parseLegacyDirectoryArray(
        directories,
        `harbors.storage.legacyPluginDataDirectories.${pluginName}`,
      ))];
    }),
  ));
  return { legacyDataDirectories, legacyPluginDataDirectories };
}

function parseScripts(value: unknown): RepositoryKitScripts {
  const input = record(value, 'harbors.scripts');
  exactKeys(input, ['build', 'test', 'smoke'], 'harbors.scripts');
  const build = stringValue(input.build, 'harbors.scripts.build');
  const test = stringValue(input.test, 'harbors.scripts.test');
  const smoke = input.smoke === undefined
    ? undefined
    : stringValue(input.smoke, 'harbors.scripts.smoke');
  return smoke === undefined
    ? { build, test }
    : { build, test, smoke };
}

export function parseRepositoryKitPackage(value: unknown): RepositoryKitPackageMetadata {
  const input = record(value, 'harbors');
  exactKeys(input, ['distribution', 'default', 'ci', 'docs', 'resources', 'storage', 'scripts'], 'harbors');

  const distribution = enumValue<KitDistribution>(
    input.distribution,
    ['builtin', 'market'],
    'harbors.distribution',
  );
  if (input.default !== undefined && typeof input.default !== 'boolean') {
    throw new Error('harbors.default must be a boolean');
  }
  const isDefault = input.default === true;
  if (isDefault && distribution !== 'builtin') {
    throw new Error('harbors.default may be true only for builtin distribution');
  }

  const ci = record(input.ci, 'harbors.ci');
  exactKeys(ci, ['runner'], 'harbors.ci');
  const ciRunner = enumValue<SupportedRunner>(
    ci.runner,
    SUPPORTED_KIT_RUNNERS,
    'harbors.ci.runner',
  );

  const docs = record(input.docs, 'harbors.docs');
  exactKeys(docs, ['summary'], 'harbors.docs');
  const summary = stringValue(docs.summary, 'harbors.docs.summary');

  const resources = input.resources === undefined ? [] : parseResources(input.resources);
  const storage = input.storage === undefined
    ? { legacyDataDirectories: [], legacyPluginDataDirectories: Object.freeze({}) }
    : parseStorage(input.storage);
  const scripts = parseScripts(input.scripts);

  return Object.freeze({
    distribution,
    isDefault,
    ciRunner,
    summary,
    scripts: Object.freeze(scripts),
    resources: Object.freeze(resources),
    legacyDataDirectories: Object.freeze(storage.legacyDataDirectories),
    legacyPluginDataDirectories: storage.legacyPluginDataDirectories,
  });
}
