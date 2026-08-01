import {
  resolveCredentialMode,
  type CredentialMode,
} from '@itharbors/host-security';

export interface GatewaySecurityEnvironment {
  HARBORS_HOST_MODE?: string;
  HARBORS_CREDENTIAL_MODE?: string;
  HARBORS_BIND_HOST?: string;
}

export function resolveGatewayCredentialMode(
  env: GatewaySecurityEnvironment,
): CredentialMode {
  return resolveCredentialMode({
    hostMode: env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web',
    requested: env.HARBORS_CREDENTIAL_MODE,
    bindHost: env.HARBORS_BIND_HOST,
  });
}
