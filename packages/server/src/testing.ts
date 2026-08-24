export { createDefaultAssemblyConfig } from './assembly/config';
export type { PluginPathRoots } from '@itharbors/magnet';
export { CredentialStore } from './credentials/store';
export { CredentialVault } from './credentials/vault';
export {
  CREDENTIAL_HEALTH_ACCOUNT,
  createNativeKeyringAdapter,
  type KeyringAdapter,
  type KeyringModule,
} from './credentials/keyring';
export { credentialScopeDigest } from './credentials/scope';
export { createServer } from './server';
export {
  createPluginRuntimeHarness,
  createKitAssemblyHarness,
  type CredentialTestDouble,
  type KitAssemblyHarness,
  type KitAssemblyHarnessOptions,
  type MessageMockBroadcast,
  type MessageMockRequest,
  type MessageObserver,
  type MessageRouteSnapshot,
  type MessageTraceEvent,
  type PluginRuntimeHarness,
  type PluginRuntimeHarnessOptions,
  type RuntimeMessages,
} from './testing/harness';
