export { createDefaultAssemblyConfig } from './assembly/config';
export { createEditor } from './editor/index';
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
