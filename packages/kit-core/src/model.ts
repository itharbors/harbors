export const KIT_PACKAGE_SCHEMA_VERSION = 1 as const;
export const KIT_API_VERSION = '1.0.0' as const;
export const KIT_PERMISSIONS = [
  'network',
  'filesystem',
  'native-code',
  'application-startup',
] as const;

export type KitChannel = 'stable' | 'preview';
export type KitPermission = typeof KIT_PERMISSIONS[number];
export type KitPlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type KitArchitecture = 'any' | 'arm64' | 'x64';

export interface KitTarget {
  platform: KitPlatform;
  arch: KitArchitecture;
  nodeAbi?: string;
}

export interface KitRequirements {
  harbors: string;
  kitApi: string;
  protocolVersion: number;
}

export interface KitPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  channel: KitChannel;
  publisher: string;
  requires: KitRequirements;
  target: KitTarget;
  permissions: KitPermission[];
  entry: 'package.json';
}

export interface ReleaseAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
  manifest: KitPackageManifest;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  channel: KitChannel;
  publisher: string;
  source: {
    repository: string;
    commit: string;
    workflow: string;
    signerWorkflow: string;
    attestationUrl: string;
  };
  assets: ReleaseAsset[];
}

export interface RegistryChannelReference {
  version: string;
  releaseManifestUrl: string;
  permissions: KitPermission[];
}

export interface RegistryKit {
  id: string;
  label: string;
  publisher: string;
  summary: string;
  channels: {
    stable?: RegistryChannelReference;
    preview?: RegistryChannelReference;
  };
}

export type KitRevocationAction = 'block-install' | 'deactivate';

export interface KitRevocation {
  id: string;
  version: string;
  sha256: string;
  reason: string;
  action: KitRevocationAction;
}

export interface KitRegistryIndex {
  schemaVersion: 1;
  generatedAt: string;
  kits: RegistryKit[];
  revocations: KitRevocation[];
}

export interface InstalledKitVersion {
  version: string;
  directory: string;
  digest: string;
  source: {
    publisher: string;
    repository: string;
    commit: string;
  };
  installedAt: string;
}

export interface InstalledKitRecord {
  active?: string;
  previous?: string;
  pending?: string;
  channel: KitChannel;
  autoUpdate: boolean;
  versions: Record<string, InstalledKitVersion>;
  badVersions: string[];
}

export interface InstalledKitState {
  schemaVersion: 1;
  kits: Record<string, InstalledKitRecord>;
}
