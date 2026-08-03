export type CredentialMode = 'off' | 'local' | 'multi-user';

export interface CredentialModeInput {
  hostMode: 'desktop' | 'web';
  requested?: string;
  bindHost?: string;
}

export function resolveCredentialMode(input: CredentialModeInput): CredentialMode {
  const mode = input.requested ?? (input.hostMode === 'desktop' ? 'local' : 'off');
  if (mode === 'multi-user') {
    throw new Error('multi-user credential mode is not implemented');
  }
  if (mode !== 'off' && mode !== 'local') {
    throw new Error('Invalid credential mode');
  }
  if (mode === 'local' && input.bindHost !== '127.0.0.1' && input.bindHost !== '::1') {
    throw new Error('Local credential mode requires explicit loopback');
  }
  return mode;
}
