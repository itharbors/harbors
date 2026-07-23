import { describe, expect, it } from 'vitest';

import {
  parseInstalledKitState,
  parseKitPackageManifest,
  parseKitRegistryIndex,
  parseReleaseManifest,
} from '../src/index.js';

const kitManifest = {
  schemaVersion: 1,
  id: '@example/kit-demo',
  version: '1.2.3',
  channel: 'stable',
  publisher: 'example',
  requires: {
    harbors: '>=1.0.0 <2.0.0',
    kitApi: '>=1.0.0 <2.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'any', arch: 'any' },
  permissions: ['network'],
  entry: 'package.json',
} as const;

const releaseManifest = {
  schemaVersion: 1,
  id: kitManifest.id,
  version: kitManifest.version,
  channel: kitManifest.channel,
  publisher: kitManifest.publisher,
  source: {
    repository: 'itharbors/kit-demo',
    commit: '0123456789abcdef0123456789abcdef01234567',
    workflow: 'itharbors/workflows/.github/workflows/publish-kit.yml@refs/tags/kit-publish-v1',
    signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    attestationUrl: 'https://github.com/itharbors/kit-demo/attestations/1234',
  },
  assets: [{
    name: 'demo-1.2.3-any-any.hkit',
    url: 'https://example.test/demo-1.2.3-any-any.hkit',
    sha256: 'a'.repeat(64),
    size: 123,
    manifest: kitManifest,
  }],
};

const registryIndex = {
  schemaVersion: 1,
  generatedAt: '2026-07-23T10:00:00.000Z',
  kits: [{
    id: '@example/kit-demo',
    label: 'Demo Kit',
    publisher: 'example',
    summary: 'A market fixture Kit',
    channels: {
      stable: {
        version: '1.2.3',
        releaseManifestUrl: 'https://example.test/releases/1.2.3/release.json',
        permissions: ['network'],
      },
      preview: {
        version: '1.3.0-preview.abc1234',
        releaseManifestUrl: 'https://example.test/releases/preview/release.json',
        permissions: ['network', 'native-code'],
      },
    },
  }],
  revocations: [{
    id: '@example/kit-demo',
    version: '1.1.0',
    sha256: 'f'.repeat(64),
    reason: 'COMPROMISED_ARTIFACT',
    action: 'block-install',
  }],
} as const;

describe('parseKitPackageManifest', () => {
  it('parses a complete stable publication manifest', () => {
    expect(parseKitPackageManifest(kitManifest)).toEqual(kitManifest);
  });

  it('accepts preview versions with a SemVer prerelease segment', () => {
    const preview = {
      ...kitManifest,
      version: '1.3.0-preview.a1b2c3d',
      channel: 'preview',
    };

    expect(parseKitPackageManifest(preview)).toEqual(preview);
  });

  it.each([
    'kit-demo',
    '@example',
    '@Example/kit-demo',
    '@example/Kit-Demo',
    '@example/kit demo',
  ])('rejects malformed Kit id %s', (id) => {
    expect(() => parseKitPackageManifest({ ...kitManifest, id })).toThrow(/id/i);
  });

  it('rejects unsupported schema versions and unknown fields', () => {
    expect(() => parseKitPackageManifest({ ...kitManifest, schemaVersion: 2 })).toThrow(
      /schemaVersion/i,
    );
    expect(() => parseKitPackageManifest({ ...kitManifest, unexpected: true })).toThrow(
      /unexpected/i,
    );
  });

  it('rejects versions that do not match their release channel', () => {
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      version: '1.2.3-preview.1',
    })).toThrow(/stable/i);
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      channel: 'preview',
    })).toThrow(/preview/i);
  });

  it('rejects unknown and duplicate permissions', () => {
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      permissions: ['network', 'process-control'],
    })).toThrow(/permission/i);
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      permissions: ['network', 'network'],
    })).toThrow(/duplicate/i);
  });

  it('requires a node ABI for native targets', () => {
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      target: { platform: 'darwin', arch: 'arm64' },
      permissions: ['native-code'],
    })).toThrow(/nodeAbi/i);
  });

  it('requires universal targets to use any-any without a node ABI', () => {
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      target: { platform: 'any', arch: 'arm64' },
    })).toThrow(/any target/i);
    expect(() => parseKitPackageManifest({
      ...kitManifest,
      target: { platform: 'any', arch: 'any', nodeAbi: '127' },
    })).toThrow(/any target/i);
  });
});

describe('parseReleaseManifest', () => {
  it('parses a release whose asset identity matches its release identity', () => {
    expect(parseReleaseManifest(releaseManifest)).toEqual(releaseManifest);
  });

  it('rejects duplicate asset names', () => {
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      assets: [releaseManifest.assets[0], { ...releaseManifest.assets[0] }],
    })).toThrow(/duplicate asset/i);
  });

  it('rejects invalid whole-archive SHA-256 values', () => {
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      assets: [{ ...releaseManifest.assets[0], sha256: 'abc' }],
    })).toThrow(/sha256/i);
  });

  it('rejects an asset whose manifest belongs to another release', () => {
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      assets: [{
        ...releaseManifest.assets[0],
        manifest: { ...kitManifest, version: '1.2.4' },
      }],
    })).toThrow(/identity/i);
  });

  it('requires HTTPS asset and attestation URLs and rejects unknown source fields', () => {
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      source: { ...releaseManifest.source, attestationUrl: 'http://example.test/attestation' },
    })).toThrow(/https/i);
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      assets: [{ ...releaseManifest.assets[0], url: 'http://example.test/demo.hkit' }],
    })).toThrow(/https/i);
    expect(() => parseReleaseManifest({
      ...releaseManifest,
      source: { ...releaseManifest.source, actor: 'someone' },
    })).toThrow(/unexpected/i);
  });
});

describe('parseKitRegistryIndex', () => {
  it('parses stable and preview channels plus digest-scoped revocations', () => {
    expect(parseKitRegistryIndex(registryIndex)).toEqual(registryIndex);
  });

  it('rejects duplicate Kit ids and empty channel maps', () => {
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [registryIndex.kits[0], { ...registryIndex.kits[0] }],
    })).toThrow(/duplicate.*id/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{ ...registryIndex.kits[0], channels: {} }],
    })).toThrow(/channel/i);
  });

  it('requires channel versions to match stable and preview semantics', () => {
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          stable: {
            ...registryIndex.kits[0].channels.stable,
            version: '1.2.4-preview.1',
          },
        },
      }],
    })).toThrow(/stable/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          preview: {
            ...registryIndex.kits[0].channels.preview,
            version: '1.3.0',
          },
        },
      }],
    })).toThrow(/preview/i);
  });

  it('requires canonical timestamps, HTTPS release URLs, and known revocation actions', () => {
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      generatedAt: '2026-07-23',
    })).toThrow(/timestamp/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          stable: {
            ...registryIndex.kits[0].channels.stable,
            releaseManifestUrl: 'http://example.test/release.json',
          },
        },
      }],
    })).toThrow(/https/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      revocations: [{ ...registryIndex.revocations[0], action: 'silently-delete' }],
    })).toThrow(/action/i);
  });

  it('requires explicit known permissions on every Registry channel', () => {
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          stable: {
            version: '1.2.3',
            releaseManifestUrl: 'https://example.test/release.json',
          },
        },
      }],
    })).toThrow(/permissions/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          stable: { ...registryIndex.kits[0].channels.stable, permissions: ['root'] },
        },
      }],
    })).toThrow(/permissions/i);
  });

  it('rejects unknown index, Kit, channel, and revocation fields', () => {
    expect(() => parseKitRegistryIndex({ ...registryIndex, signature: 'value' })).toThrow(
      /unexpected/i,
    );
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{ ...registryIndex.kits[0], homepage: 'https://example.test' }],
    })).toThrow(/unexpected/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      kits: [{
        ...registryIndex.kits[0],
        channels: {
          stable: { ...registryIndex.kits[0].channels.stable, latest: true },
        },
      }],
    })).toThrow(/unexpected/i);
    expect(() => parseKitRegistryIndex({
      ...registryIndex,
      revocations: [{ ...registryIndex.revocations[0], advisory: 'hidden field' }],
    })).toThrow(/unexpected/i);
  });
});

describe('parseInstalledKitState', () => {
  const installedState = {
    schemaVersion: 1,
    kits: {
      '@example/kit-demo': {
        active: '1.2.3',
        channel: 'stable',
        autoUpdate: true,
        versions: {
          '1.2.3': {
            version: '1.2.3',
            directory: '/var/lib/harbors/kits/example/1.2.3',
            digest: 'b'.repeat(64),
            source: {
              publisher: 'example',
              repository: 'itharbors/kit-demo',
              commit: '0123456789abcdef0123456789abcdef01234567',
            },
            installedAt: '2026-07-23T00:00:00.000Z',
          },
        },
        badVersions: [],
      },
    },
  } as const;

  it('parses a complete installed state', () => {
    expect(parseInstalledKitState(installedState)).toEqual(installedState);
  });

  it('rejects corrupt records and dangling active versions', () => {
    expect(() => parseInstalledKitState({ schemaVersion: 1, kits: [] })).toThrow(/kits/i);
    expect(() => parseInstalledKitState({
      ...installedState,
      kits: {
        '@example/kit-demo': {
          ...installedState.kits['@example/kit-demo'],
          active: '9.9.9',
        },
      },
    })).toThrow(/active/i);
  });

  it('rejects a version entry whose key and value disagree', () => {
    const record = installedState.kits['@example/kit-demo'];
    expect(() => parseInstalledKitState({
      ...installedState,
      kits: {
        '@example/kit-demo': {
          ...record,
          versions: {
            '1.2.4': record.versions['1.2.3'],
          },
        },
      },
    })).toThrow(/version key/i);
  });
});
