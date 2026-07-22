import { resolveRuntimePorts, resolveRuntimeProfile } from './runtime-ports.mjs';

export function createDevServerEnv(baseEnv, requestedKit) {
  const serverEnv = { ...baseEnv };
  delete serverEnv.CE_DEFAULT_KIT;
  delete serverEnv.CE_KIT_MODE;
  if (requestedKit) serverEnv.CE_DEFAULT_KIT = requestedKit;
  return serverEnv;
}

export function createDevStackEnvironments(baseEnv, requestedKit, profile = 'development') {
  const runtimeProfile = resolveRuntimeProfile(baseEnv.HARBORS_RUNTIME_PROFILE, profile);
  const ports = resolveRuntimePorts(baseEnv, runtimeProfile);
  const common = {
    ...baseEnv,
    HARBORS_RUNTIME_PROFILE: runtimeProfile,
    HARBORS_NOTIFICATION_PORT: String(ports.notification),
  };
  delete common.PORT;
  delete common.SERVER_PORT;
  delete common.CLIENT_PORT;
  return {
    ports,
    gatewayEnv: {
      ...common,
      PORT: String(ports.gateway),
      SERVER_PORT: String(ports.server),
      CLIENT_PORT: String(ports.client),
    },
    serverEnv: { ...createDevServerEnv(common, requestedKit), PORT: String(ports.server) },
    clientEnv: { ...common, CLIENT_PORT: String(ports.client) },
  };
}

export function createDevPages(requestedKit) {
  return [
    ['Kit chooser', '/'],
    ...(requestedKit ? [['Requested Kit', `/?kit=${encodeURIComponent(requestedKit)}`]] : []),
    ['Layout Kit', '/?page=layout-kit'],
    ['UI Kit', '/?page=ui-kit'],
  ];
}
