import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVELOPMENT_PORTS, STABLE_PORTS, resolveRuntimePorts } from './runtime-ports.mjs';

test('keeps stable and development ports disjoint', () => {
  assert.deepEqual(STABLE_PORTS, { gateway: 48380, server: 48381, client: 48382, notification: 48383 });
  assert.deepEqual(DEVELOPMENT_PORTS, { gateway: 49380, server: 49381, client: 49382, notification: 49383 });
  assert.deepEqual(resolveRuntimePorts({}, 'development'), DEVELOPMENT_PORTS);
  assert.deepEqual(resolveRuntimePorts({}, 'stable'), STABLE_PORTS);
});

test('uses explicit Harbors port overrides and rejects collisions', () => {
  assert.deepEqual(resolveRuntimePorts({
    HARBORS_GATEWAY_PORT: '19080', HARBORS_SERVER_PORT: '19000',
    HARBORS_CLIENT_PORT: '19573', HARBORS_NOTIFICATION_PORT: '19896',
  }, 'development'), { gateway: 19080, server: 19000, client: 19573, notification: 19896 });
  assert.throws(() => resolveRuntimePorts({ HARBORS_GATEWAY_PORT: '0' }, 'development'), /HARBORS_GATEWAY_PORT/);
  assert.throws(() => resolveRuntimePorts({ HARBORS_GATEWAY_PORT: '49380', HARBORS_SERVER_PORT: '49380' }, 'development'), /unique/i);
});
