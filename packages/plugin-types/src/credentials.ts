export type CredentialMode = 'off' | 'local' | 'multi-user';

export type CredentialCapabilitySnapshot =
  | { mode: CredentialMode; status: 'available' }
  | {
      mode: CredentialMode;
      status: 'unavailable';
      reason:
        | 'CREDENTIALS_DISABLED'
        | 'CREDENTIALS_UNAVAILABLE'
        | 'CREDENTIALS_LOCKED';
    };

export interface CredentialProfile {
  id: string;
  label: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface PluginCredentialVault {
  capability(): Promise<CredentialCapabilitySnapshot>;
  available(): Promise<boolean>;
  list(): Promise<CredentialProfile[]>;
  get(id: string): Promise<{ profile: CredentialProfile; secret: string }>;
  put(input: {
    id?: string;
    label: string;
    metadata: CredentialProfile['metadata'];
    secret: string;
  }): Promise<CredentialProfile>;
  delete(id: string): Promise<void>;
}
