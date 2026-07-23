import semver from 'semver';

import type { KitPackageManifest, ReleaseAsset, ReleaseManifest } from './model.js';

export interface KitRuntimeIdentity {
  harborsVersion: string;
  kitApiVersion: string;
  protocolVersion: number;
  platform: string;
  arch: string;
  nodeAbi: string;
}

export type CompatibilityReason =
  | 'HARBORS_INCOMPATIBLE'
  | 'KIT_API_INCOMPATIBLE'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'PLATFORM_INCOMPATIBLE'
  | 'ARCH_INCOMPATIBLE'
  | 'NODE_ABI_INCOMPATIBLE';

export type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; reason: CompatibilityReason; message: string };

function incompatible(
  reason: CompatibilityReason,
  message: string,
): CompatibilityResult {
  return { compatible: false, reason, message };
}

export function checkKitCompatibility(
  manifest: KitPackageManifest,
  runtime: KitRuntimeIdentity,
): CompatibilityResult {
  const semverOptions = { includePrerelease: true } as const;
  if (!semver.satisfies(runtime.harborsVersion, manifest.requires.harbors, semverOptions)) {
    return incompatible(
      'HARBORS_INCOMPATIBLE',
      `Harbors ${runtime.harborsVersion} does not satisfy ${manifest.requires.harbors}`,
    );
  }
  if (!semver.satisfies(runtime.kitApiVersion, manifest.requires.kitApi, semverOptions)) {
    return incompatible(
      'KIT_API_INCOMPATIBLE',
      `Kit API ${runtime.kitApiVersion} does not satisfy ${manifest.requires.kitApi}`,
    );
  }
  if (runtime.protocolVersion !== manifest.requires.protocolVersion) {
    return incompatible(
      'PROTOCOL_INCOMPATIBLE',
      `Protocol ${runtime.protocolVersion} does not match ${manifest.requires.protocolVersion}`,
    );
  }

  const { target } = manifest;
  if (target.platform === 'any' && target.arch === 'any') {
    return { compatible: true };
  }
  if (target.platform !== runtime.platform) {
    return incompatible(
      'PLATFORM_INCOMPATIBLE',
      `Platform ${runtime.platform} does not match ${target.platform}`,
    );
  }
  if (target.arch !== runtime.arch) {
    return incompatible(
      'ARCH_INCOMPATIBLE',
      `Architecture ${runtime.arch} does not match ${target.arch}`,
    );
  }
  if (target.nodeAbi !== undefined && target.nodeAbi !== runtime.nodeAbi) {
    return incompatible(
      'NODE_ABI_INCOMPATIBLE',
      `Node ABI ${runtime.nodeAbi} does not match ${target.nodeAbi}`,
    );
  }
  return { compatible: true };
}

function assetPreference(asset: ReleaseAsset): number {
  return asset.manifest.target.platform === 'any' ? 0 : 1;
}

export function selectCompatibleAsset(
  release: ReleaseManifest,
  runtime: KitRuntimeIdentity,
): ReleaseAsset {
  const compatible = release.assets.filter(
    (asset) => checkKitCompatibility(asset.manifest, runtime).compatible,
  );
  if (compatible.length === 0) {
    throw new Error(`No compatible asset for ${release.id}@${release.version}`);
  }

  const bestPreference = Math.max(...compatible.map(assetPreference));
  const best = compatible.filter((asset) => assetPreference(asset) === bestPreference);
  if (best.length !== 1) {
    throw new Error(`Ambiguous compatible assets for ${release.id}@${release.version}`);
  }
  return best[0];
}
