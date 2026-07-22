export const STABLE_PORTS = Object.freeze({ gateway: 48380, server: 48381, client: 48382, notification: 48383 });
export const DEVELOPMENT_PORTS = Object.freeze({ gateway: 49380, server: 49381, client: 49382, notification: 49383 });

const PORT_ENV = {
  gateway: 'HARBORS_GATEWAY_PORT', server: 'HARBORS_SERVER_PORT',
  client: 'HARBORS_CLIENT_PORT', notification: 'HARBORS_NOTIFICATION_PORT',
};

export function resolveRuntimeProfile(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'stable' || value === 'development') return value;
  throw new Error('HARBORS_RUNTIME_PROFILE must be "stable" or "development"');
}

export function resolveRuntimePorts(env, profile) {
  const defaults = profile === 'stable' ? STABLE_PORTS : DEVELOPMENT_PORTS;
  const ports = Object.fromEntries(Object.entries(PORT_ENV).map(([name, envName]) => [
    name, parsePort(env[envName], defaults[name], envName),
  ]));
  if (new Set(Object.values(ports)).size !== 4) throw new Error('Harbors runtime ports must be unique');
  return ports;
}

function parsePort(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer between 1 and 65535`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}
