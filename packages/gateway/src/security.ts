import {
  resolveCredentialMode,
  type CredentialMode,
} from '@itharbors/host-security';

export interface GatewaySecurityEnvironment {
  HARBORS_CREDENTIAL_MODE?: string;
}

export function resolveGatewayCredentialMode(
  env: GatewaySecurityEnvironment,
): CredentialMode {
  return resolveCredentialMode({
    requested: env.HARBORS_CREDENTIAL_MODE,
  });
}

export function resolveGatewayUpstreamHost(bindHost: string | undefined): string {
  if (!bindHost) return 'localhost';
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::') return '::1';
  return bindHost;
}
