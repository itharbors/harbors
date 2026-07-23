import { describe, expect, it } from 'vitest';

import {
  checkKitCompatibility,
  selectCompatibleAsset,
  type KitPackageManifest,
  type KitRuntimeIdentity,
  type ReleaseAsset,
  type ReleaseManifest,
} from '../src/index.js';

const runtime: KitRuntimeIdentity = {
  harborsVersion: '1.4.0',
  kitApiVersion: '1.2.0',
  protocolVersion: 1,
  platform: 'darwin',
  arch: 'arm64',
  nodeAbi: '127',
};

const universalManifest: KitPackageManifest = {
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
};

function reasonFor(manifest: KitPackageManifest): string | undefined {
  const result = checkKitCompatibility(manifest, runtime);
  return result.compatible ? undefined : result.reason;
}

describe('checkKitCompatibility', () => {
  it('accepts a universal Kit within every declared version range', () => {
    expect(checkKitCompatibility(universalManifest, runtime)).toEqual({ compatible: true });
  });

  it('reports Framework incompatibility first', () => {
    expect(reasonFor({
      ...universalManifest,
      requires: {
        harbors: '>=2.0.0',
        kitApi: '>=2.0.0',
        protocolVersion: 2,
      },
    })).toBe('HARBORS_INCOMPATIBLE');
  });

  it('reports Kit API incompatibility after Framework compatibility', () => {
    expect(reasonFor({
      ...universalManifest,
      requires: { ...universalManifest.requires, kitApi: '>=2.0.0' },
    })).toBe('KIT_API_INCOMPATIBLE');
  });

  it('reports protocol incompatibility before target incompatibility', () => {
    expect(reasonFor({
      ...universalManifest,
      requires: { ...universalManifest.requires, protocolVersion: 2 },
      target: { platform: 'linux', arch: 'x64' },
    })).toBe('PROTOCOL_INCOMPATIBLE');
  });

  it('reports platform incompatibility before architecture incompatibility', () => {
    expect(reasonFor({
      ...universalManifest,
      target: { platform: 'linux', arch: 'x64' },
    })).toBe('PLATFORM_INCOMPATIBLE');
  });

  it('reports architecture incompatibility for the current platform', () => {
    expect(reasonFor({
      ...universalManifest,
      target: { platform: 'darwin', arch: 'x64' },
    })).toBe('ARCH_INCOMPATIBLE');
  });

  it('reports Node ABI incompatibility after an exact platform target match', () => {
    expect(reasonFor({
      ...universalManifest,
      target: { platform: 'darwin', arch: 'arm64', nodeAbi: '128' },
      permissions: ['native-code'],
    })).toBe('NODE_ABI_INCOMPATIBLE');
  });

  it('accepts matching prerelease Framework and Kit API identities', () => {
    const prereleaseRuntime = {
      ...runtime,
      harborsVersion: '1.5.0-preview.1',
      kitApiVersion: '1.3.0-preview.2',
    };
    const manifest = {
      ...universalManifest,
      requires: {
        ...universalManifest.requires,
        harbors: '>=1.5.0-preview.1 <2.0.0',
        kitApi: '>=1.3.0-preview.1 <2.0.0',
      },
    };

    expect(checkKitCompatibility(manifest, prereleaseRuntime)).toEqual({ compatible: true });
  });
});

function asset(name: string, manifest: KitPackageManifest): ReleaseAsset {
  return {
    name,
    url: `https://example.test/${name}`,
    sha256: name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
    size: 123,
    manifest,
  };
}

function release(assets: ReleaseAsset[]): ReleaseManifest {
  return {
    schemaVersion: 1,
    id: universalManifest.id,
    version: universalManifest.version,
    channel: universalManifest.channel,
    publisher: universalManifest.publisher,
    source: {
      repository: 'example/kit-demo',
      commit: '0123456789abcdef0123456789abcdef01234567',
      workflow: 'example/workflows/publish.yml@refs/tags/v1',
      signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
      attestationUrl: 'https://github.com/example/kit-demo/attestations/1234',
    },
    assets,
  };
}

describe('selectCompatibleAsset', () => {
  const nativeManifest: KitPackageManifest = {
    ...universalManifest,
    target: { platform: 'darwin', arch: 'arm64', nodeAbi: '127' },
    permissions: ['native-code'],
  };

  it('prefers an exact native target over a compatible universal fallback', () => {
    const universal = asset('universal.hkit', universalManifest);
    const native = asset('native.hkit', nativeManifest);

    expect(selectCompatibleAsset(release([universal, native]), runtime)).toBe(native);
  });

  it('uses the universal fallback when exact assets are incompatible', () => {
    const universal = asset('universal.hkit', universalManifest);
    const linux = asset('linux.hkit', {
      ...nativeManifest,
      target: { platform: 'linux', arch: 'arm64', nodeAbi: '127' },
    });

    expect(selectCompatibleAsset(release([linux, universal]), runtime)).toBe(universal);
  });

  it('rejects a release without a compatible asset', () => {
    const linux = asset('linux.hkit', {
      ...nativeManifest,
      target: { platform: 'linux', arch: 'arm64', nodeAbi: '127' },
    });

    expect(() => selectCompatibleAsset(release([linux]), runtime)).toThrow(
      'No compatible asset for @example/kit-demo@1.2.3',
    );
  });

  it('rejects multiple equally preferred compatible assets', () => {
    expect(() => selectCompatibleAsset(release([
      asset('native-a.hkit', nativeManifest),
      asset('native-b.hkit', nativeManifest),
    ]), runtime)).toThrow('Ambiguous compatible assets for @example/kit-demo@1.2.3');
  });
});
