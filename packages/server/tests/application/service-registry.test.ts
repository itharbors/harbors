import { describe, expect, it } from 'vitest';
import { ApplicationServiceRegistry } from '../../src/application/service-registry';

describe('ApplicationServiceRegistry', () => {
  it('keeps service names unique across owners', () => {
    const registry = new ApplicationServiceRegistry();
    const service = { ready: true };

    registry.register('notifications', 'notification-client', service);

    expect(registry.get('notification-client')).toBe(service);
    expect(() => registry.register('telemetry', 'notification-client', {}))
      .toThrow(/already registered.*notifications/i);
  });

  it('allows only the owner to unregister and clears one owner at a time', () => {
    const registry = new ApplicationServiceRegistry();
    registry.register('notifications', 'notification-client', { ready: true });
    registry.register('telemetry', 'telemetry-client', { ready: true });

    expect(() => registry.unregister('telemetry', 'notification-client'))
      .toThrow(/owned by.*notifications/i);

    registry.clearOwner('notifications');

    expect(registry.get('notification-client')).toBeUndefined();
    expect(registry.get('telemetry-client')).toEqual({ ready: true });
  });
});
