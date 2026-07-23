import semver from 'semver';

import {
  KIT_PACKAGE_SCHEMA_VERSION,
  KIT_PERMISSIONS,
  type InstalledKitRecord,
  type InstalledKitState,
  type InstalledKitVersion,
  type KitRegistryIndex,
  type KitRevocation,
  type KitRevocationAction,
  type KitArchitecture,
  type KitChannel,
  type KitPackageManifest,
  type KitPermission,
  type KitPlatform,
  type KitRequirements,
  type KitTarget,
  type ReleaseAsset,
  type ReleaseManifest,
  type RegistryChannelReference,
  type RegistryKit,
} from './model.js';

type UnknownRecord = Record<string, unknown>;

const KIT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

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

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean`);
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

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value as number;
}

function semverValue(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (semver.valid(parsed) !== parsed) {
    throw new Error(`${context} must be a canonical SemVer version`);
  }
  return parsed;
}

function semverRange(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (semver.validRange(parsed) === null) {
    throw new Error(`${context} must be a valid SemVer range`);
  }
  return parsed;
}

function sha256(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!SHA256_PATTERN.test(parsed)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}

function commitSha(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!COMMIT_PATTERN.test(parsed)) {
    throw new Error(`${context} must be a lowercase 40-character commit SHA`);
  }
  return parsed;
}

function httpsUrl(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${context} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${context} must be an absolute HTTPS URL`);
  }
  return parsed;
}

function kitId(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!KIT_ID_PATTERN.test(parsed)) {
    throw new Error(`${context} must be a lowercase scoped package id`);
  }
  return parsed;
}

function parseChannel(value: unknown, context: string): KitChannel {
  return enumValue(value, ['stable', 'preview'], context);
}

function parseRequirements(value: unknown): KitRequirements {
  const input = record(value, 'requires');
  exactKeys(input, ['harbors', 'kitApi', 'protocolVersion'], 'requires');
  return {
    harbors: semverRange(input.harbors, 'requires.harbors'),
    kitApi: semverRange(input.kitApi, 'requires.kitApi'),
    protocolVersion: positiveInteger(input.protocolVersion, 'requires.protocolVersion'),
  };
}

function parseTarget(value: unknown, permissions: readonly KitPermission[]): KitTarget {
  const input = record(value, 'target');
  exactKeys(input, ['platform', 'arch', 'nodeAbi'], 'target');
  const platform = enumValue<KitPlatform>(
    input.platform,
    ['any', 'darwin', 'linux', 'win32'],
    'target.platform',
  );
  const arch = enumValue<KitArchitecture>(
    input.arch,
    ['any', 'arm64', 'x64'],
    'target.arch',
  );
  const nodeAbi = input.nodeAbi === undefined
    ? undefined
    : stringValue(input.nodeAbi, 'target.nodeAbi');

  if (nodeAbi !== undefined && !/^\d+$/.test(nodeAbi)) {
    throw new Error('target.nodeAbi must be a numeric Node ABI');
  }
  if (platform === 'any' || arch === 'any') {
    if (platform !== 'any' || arch !== 'any' || nodeAbi !== undefined) {
      throw new Error('any target must use platform=any, arch=any, and omit nodeAbi');
    }
  } else if (permissions.includes('native-code') && !nodeAbi) {
    throw new Error('native-code target requires nodeAbi');
  }

  return nodeAbi === undefined ? { platform, arch } : { platform, arch, nodeAbi };
}

function parsePermissions(value: unknown): KitPermission[] {
  if (!Array.isArray(value)) {
    throw new Error('permissions must be an array');
  }
  const permissions = value.map((permission, index) => enumValue(
    permission,
    KIT_PERMISSIONS,
    `permissions[${index}]`,
  ));
  if (new Set(permissions).size !== permissions.length) {
    throw new Error('permissions contains duplicate values');
  }
  return permissions;
}

export function parseKitPackageManifest(value: unknown): KitPackageManifest {
  const input = record(value, 'Kit package manifest');
  exactKeys(input, [
    'schemaVersion',
    'id',
    'version',
    'channel',
    'publisher',
    'requires',
    'target',
    'permissions',
    'entry',
  ], 'Kit package manifest');

  if (input.schemaVersion !== KIT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(input.schemaVersion)}`);
  }
  const id = kitId(input.id, 'id');
  const version = semverValue(input.version, 'version');
  const channel = parseChannel(input.channel, 'channel');
  const prerelease = semver.prerelease(version);
  if (channel === 'stable' && prerelease !== null) {
    throw new Error('stable channel requires a version without a prerelease segment');
  }
  if (channel === 'preview' && prerelease === null) {
    throw new Error('preview channel requires a SemVer prerelease segment');
  }
  const permissions = parsePermissions(input.permissions);
  const entry = input.entry;
  if (entry !== 'package.json') {
    throw new Error('entry must equal package.json');
  }

  return {
    schemaVersion: KIT_PACKAGE_SCHEMA_VERSION,
    id,
    version,
    channel,
    publisher: stringValue(input.publisher, 'publisher'),
    requires: parseRequirements(input.requires),
    target: parseTarget(input.target, permissions),
    permissions,
    entry,
  };
}

function parseReleaseAsset(value: unknown): ReleaseAsset {
  const input = record(value, 'release asset');
  exactKeys(input, ['name', 'url', 'sha256', 'size', 'manifest'], 'release asset');
  return {
    name: stringValue(input.name, 'release asset name'),
    url: httpsUrl(input.url, 'release asset url'),
    sha256: sha256(input.sha256, 'release asset sha256'),
    size: positiveInteger(input.size, 'release asset size'),
    manifest: parseKitPackageManifest(input.manifest),
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const input = record(value, 'release manifest');
  exactKeys(input, [
    'schemaVersion',
    'id',
    'version',
    'channel',
    'publisher',
    'source',
    'assets',
  ], 'release manifest');
  if (input.schemaVersion !== KIT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(input.schemaVersion)}`);
  }
  const id = kitId(input.id, 'release id');
  const version = semverValue(input.version, 'release version');
  const channel = parseChannel(input.channel, 'release channel');
  const publisher = stringValue(input.publisher, 'release publisher');
  const sourceInput = record(input.source, 'release source');
  exactKeys(
    sourceInput,
    ['repository', 'commit', 'workflow', 'signerWorkflow', 'attestationUrl'],
    'release source',
  );
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new Error('release assets must be a non-empty array');
  }
  const assets = input.assets.map(parseReleaseAsset);
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error('release manifest contains a duplicate asset name');
  }
  for (const asset of assets) {
    const manifest = asset.manifest;
    if (
      manifest.id !== id
      || manifest.version !== version
      || manifest.channel !== channel
      || manifest.publisher !== publisher
    ) {
      throw new Error(`release asset ${asset.name} has a mismatched release identity`);
    }
  }

  return {
    schemaVersion: KIT_PACKAGE_SCHEMA_VERSION,
    id,
    version,
    channel,
    publisher,
    source: {
      repository: stringValue(sourceInput.repository, 'release source repository'),
      commit: commitSha(sourceInput.commit, 'release source commit'),
      workflow: stringValue(sourceInput.workflow, 'release source workflow'),
      signerWorkflow: stringValue(sourceInput.signerWorkflow, 'release source signerWorkflow'),
      attestationUrl: httpsUrl(sourceInput.attestationUrl, 'release source attestationUrl'),
    },
    assets,
  };
}

function isoDate(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) {
    throw new Error(`${context} must be an ISO-8601 UTC timestamp`);
  }
  return parsed;
}

function parseRegistryChannel(
  value: unknown,
  channel: KitChannel,
): RegistryChannelReference {
  const input = record(value, `registry ${channel} channel`);
  exactKeys(input, ['version', 'releaseManifestUrl', 'permissions'], `registry ${channel} channel`);
  const version = semverValue(input.version, `registry ${channel} version`);
  const prerelease = semver.prerelease(version);
  if (channel === 'stable' && prerelease !== null) {
    throw new Error('registry stable channel requires a version without a prerelease segment');
  }
  if (channel === 'preview' && prerelease === null) {
    throw new Error('registry preview channel requires a SemVer prerelease segment');
  }
  return {
    version,
    releaseManifestUrl: httpsUrl(
      input.releaseManifestUrl,
      `registry ${channel} releaseManifestUrl`,
    ),
    permissions: parsePermissions(input.permissions),
  };
}

function parseRegistryKit(value: unknown): RegistryKit {
  const input = record(value, 'registry Kit');
  exactKeys(input, ['id', 'label', 'publisher', 'summary', 'channels'], 'registry Kit');
  const channelsInput = record(input.channels, 'registry Kit channels');
  exactKeys(channelsInput, ['stable', 'preview'], 'registry Kit channels');
  if (channelsInput.stable === undefined && channelsInput.preview === undefined) {
    throw new Error('registry Kit must define at least one channel');
  }
  return {
    id: kitId(input.id, 'registry Kit id'),
    label: stringValue(input.label, 'registry Kit label'),
    publisher: stringValue(input.publisher, 'registry Kit publisher'),
    summary: stringValue(input.summary, 'registry Kit summary'),
    channels: {
      ...(channelsInput.stable === undefined
        ? {}
        : { stable: parseRegistryChannel(channelsInput.stable, 'stable') }),
      ...(channelsInput.preview === undefined
        ? {}
        : { preview: parseRegistryChannel(channelsInput.preview, 'preview') }),
    },
  };
}

function parseRevocation(value: unknown): KitRevocation {
  const input = record(value, 'registry revocation');
  exactKeys(input, ['id', 'version', 'sha256', 'reason', 'action'], 'registry revocation');
  return {
    id: kitId(input.id, 'registry revocation id'),
    version: semverValue(input.version, 'registry revocation version'),
    sha256: sha256(input.sha256, 'registry revocation sha256'),
    reason: stringValue(input.reason, 'registry revocation reason'),
    action: enumValue<KitRevocationAction>(
      input.action,
      ['block-install', 'deactivate'],
      'registry revocation action',
    ),
  };
}

export function parseKitRegistryIndex(value: unknown): KitRegistryIndex {
  const input = record(value, 'Kit Registry index');
  exactKeys(input, ['schemaVersion', 'generatedAt', 'kits', 'revocations'], 'Kit Registry index');
  if (input.schemaVersion !== KIT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.kits)) throw new Error('Kit Registry kits must be an array');
  if (!Array.isArray(input.revocations)) {
    throw new Error('Kit Registry revocations must be an array');
  }
  const kits = input.kits.map(parseRegistryKit);
  if (new Set(kits.map((kit) => kit.id)).size !== kits.length) {
    throw new Error('Kit Registry contains a duplicate Kit id');
  }
  const revocations = input.revocations.map(parseRevocation);
  const revocationKeys = revocations.map((item) => `${item.id}\0${item.version}\0${item.sha256}`);
  if (new Set(revocationKeys).size !== revocationKeys.length) {
    throw new Error('Kit Registry contains a duplicate revocation');
  }
  return {
    schemaVersion: KIT_PACKAGE_SCHEMA_VERSION,
    generatedAt: isoDate(input.generatedAt, 'Kit Registry generatedAt timestamp'),
    kits,
    revocations,
  };
}

function parseInstalledVersion(value: unknown): InstalledKitVersion {
  const input = record(value, 'installed version');
  exactKeys(
    input,
    ['version', 'directory', 'digest', 'source', 'installedAt'],
    'installed version',
  );
  const sourceInput = record(input.source, 'installed version source');
  exactKeys(sourceInput, ['publisher', 'repository', 'commit'], 'installed version source');
  return {
    version: semverValue(input.version, 'installed version'),
    directory: stringValue(input.directory, 'installed version directory'),
    digest: sha256(input.digest, 'installed version digest'),
    source: {
      publisher: stringValue(sourceInput.publisher, 'installed version source publisher'),
      repository: stringValue(sourceInput.repository, 'installed version source repository'),
      commit: commitSha(sourceInput.commit, 'installed version source commit'),
    },
    installedAt: isoDate(input.installedAt, 'installed version installedAt'),
  };
}

function optionalVersion(
  input: UnknownRecord,
  field: 'active' | 'previous' | 'pending',
): string | undefined {
  return input[field] === undefined
    ? undefined
    : semverValue(input[field], `installed Kit ${field}`);
}

function parseInstalledRecord(value: unknown): InstalledKitRecord {
  const input = record(value, 'installed Kit record');
  exactKeys(
    input,
    ['active', 'previous', 'pending', 'channel', 'autoUpdate', 'versions', 'badVersions'],
    'installed Kit record',
  );
  const versionsInput = record(input.versions, 'installed Kit versions');
  const versions: Record<string, InstalledKitVersion> = {};
  for (const [versionKey, rawVersion] of Object.entries(versionsInput)) {
    const parsedKey = semverValue(versionKey, 'installed version key');
    const parsedVersion = parseInstalledVersion(rawVersion);
    if (parsedVersion.version !== parsedKey) {
      throw new Error(`installed version key ${versionKey} does not match its version value`);
    }
    versions[versionKey] = parsedVersion;
  }
  if (!Array.isArray(input.badVersions)) {
    throw new Error('installed Kit badVersions must be an array');
  }
  const badVersions = input.badVersions.map((version, index) => semverValue(
    version,
    `installed Kit badVersions[${index}]`,
  ));
  if (new Set(badVersions).size !== badVersions.length) {
    throw new Error('installed Kit badVersions contains duplicate versions');
  }

  const active = optionalVersion(input, 'active');
  const previous = optionalVersion(input, 'previous');
  const pending = optionalVersion(input, 'pending');
  for (const [field, version] of Object.entries({ active, previous, pending })) {
    if (version !== undefined && versions[version] === undefined) {
      throw new Error(`installed Kit ${field} version ${version} is not installed`);
    }
  }

  return {
    ...(active === undefined ? {} : { active }),
    ...(previous === undefined ? {} : { previous }),
    ...(pending === undefined ? {} : { pending }),
    channel: parseChannel(input.channel, 'installed Kit channel'),
    autoUpdate: booleanValue(input.autoUpdate, 'installed Kit autoUpdate'),
    versions,
    badVersions,
  };
}

export function parseInstalledKitState(value: unknown): InstalledKitState {
  const input = record(value, 'installed state');
  exactKeys(input, ['schemaVersion', 'kits'], 'installed state');
  if (input.schemaVersion !== KIT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(input.schemaVersion)}`);
  }
  const kitsInput = record(input.kits, 'installed state kits');
  const kits: Record<string, InstalledKitRecord> = {};
  for (const [id, rawRecord] of Object.entries(kitsInput)) {
    kitId(id, 'installed Kit id');
    kits[id] = parseInstalledRecord(rawRecord);
  }
  return { schemaVersion: KIT_PACKAGE_SCHEMA_VERSION, kits };
}
