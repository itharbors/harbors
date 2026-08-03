import { createHash } from 'node:crypto';

export const CREDENTIAL_SERVICE = 'com.itharbors.credentials.v1';

export function credentialScopeDigest(kitId: string, pluginName: string): string {
  return createHash('sha256')
    .update(`${kitId}\0${pluginName}\0local`, 'utf8')
    .digest('hex');
}

export function credentialAccount(scope: string, id: string, version: string): string {
  return `${scope}:${id}:${version}`;
}
