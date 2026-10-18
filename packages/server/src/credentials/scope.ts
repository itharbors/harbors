import { createHash } from 'node:crypto';

export const CREDENTIAL_SERVICE = 'com.itharbors.credentials.v1';

export function credentialScopeDigest(userId: string, kitId: string, pluginName: string): string {
  if ([userId, kitId, pluginName].some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('Credential scope requires non-empty userId, kitId and pluginName');
  }
  return createHash('sha256')
    .update(`user-v2\0${userId}\0${kitId}\0${pluginName}`, 'utf8')
    .digest('hex');
}

export function credentialAccount(scope: string, id: string, version: string): string {
  return `${scope}:${id}:${version}`;
}
