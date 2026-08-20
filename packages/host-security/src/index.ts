export type CredentialMode = 'off' | 'on';

export interface CredentialModeInput {
  requested?: string;
}

export function resolveCredentialMode(input: CredentialModeInput): CredentialMode {
  const mode = input.requested ?? 'on';
  if (mode !== 'off' && mode !== 'on') {
    throw new Error('Invalid credential mode');
  }
  return mode;
}
