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
  readonly ciRunner: SupportedRunner;
  readonly summary: string;
  readonly scripts: RepositoryKitScripts;
  readonly resources: readonly string[];
  readonly legacyDataDirectories: readonly string[];
}

export interface RepositoryKitDescriptor {
  readonly slug: string;
  readonly directory: string;
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly distribution: KitDistribution;
  readonly target: KitTarget;
  readonly permissions: readonly KitPermission[];
  readonly ciRunner: SupportedRunner;
  readonly summary: string;
  readonly scripts: RepositoryKitScripts;
  readonly resources: readonly string[];
  readonly legacyDataDirectories: readonly string[];
  readonly manifest: KitPackageManifest;
  readonly packageJson: Readonly<Record<string, unknown>>;
}

type UnknownRecord = Record<string, unknown>;

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

function parseLegacyDataDirectories(value: unknown): readonly string[] {
  const input = record(value, 'harbors.storage');
  exactKeys(input, ['legacyDataDirectories'], 'harbors.storage');
  if (!Array.isArray(input.legacyDataDirectories)) {
    throw new Error('harbors.storage.legacyDataDirectories must be an array');
  }
  const directories = input.legacyDataDirectories.map((directory, index) => {
    const parsed = stringValue(directory, `harbors.storage.legacyDataDirectories[${index}]`);
    if (
      parsed.includes('/')
      || parsed.includes('\\')
      || parsed.includes('\0')
      || parsed === '.'
      || parsed === '..'
      || parsed.startsWith('/')
    ) {
      throw new Error(
        `harbors.storage.legacyDataDirectories[${index}] must be a single canonical directory name`,
      );
    }
    return parsed;
  });
  if (new Set(directories).size !== directories.length) {
    throw new Error('harbors.storage.legacyDataDirectories contains duplicate values');
  }
  return directories;
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
  exactKeys(input, ['distribution', 'ci', 'docs', 'resources', 'storage', 'scripts'], 'harbors');

  const distribution = enumValue<KitDistribution>(
    input.distribution,
    ['builtin', 'market'],
    'harbors.distribution',
  );

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
  const legacyDataDirectories = input.storage === undefined
    ? []
    : parseLegacyDataDirectories(input.storage);
  const scripts = parseScripts(input.scripts);

  return Object.freeze({
    distribution,
    ciRunner,
    summary,
    scripts: Object.freeze(scripts),
    resources: Object.freeze(resources),
    legacyDataDirectories: Object.freeze(legacyDataDirectories),
  });
}
