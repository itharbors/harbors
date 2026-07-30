import { describe, expect, it, vi } from 'vitest';

import { createRecoveryWatchdog } from '../main/src/watchdog.js';
import { parseWatchdogMessage } from '../main/src/watchdog-protocol.js';

describe('recovery watchdog', () => {
  it('sends only SIGCONT to still-matching paused processes when heartbeat closes unexpectedly', async () => {
    const signal = vi.fn();
    const entry = {
      pid: 41, processStartTime: 1000, executableIdentity: 'sha256:claude',
    };
    const watchdog = createRecoveryWatchdog({
      verify: async () => true,
      signal,
    });
    watchdog.update([entry]);

    await watchdog.closeHeartbeatUnexpectedly();

    expect(signal).toHaveBeenCalledWith(41, 'SIGCONT');
  });

  it('does nothing after clean shutdown or failed revalidation', async () => {
    const signal = vi.fn();
    const watchdog = createRecoveryWatchdog({ verify: async () => false, signal });
    watchdog.update([{ pid: 41, processStartTime: 1000, executableIdentity: 'id' }]);
    await watchdog.cleanShutdown();
    await watchdog.closeHeartbeatUnexpectedly();
    expect(signal).not.toHaveBeenCalled();
  });

  it('rejects protocol fields that could expand watchdog authority', () => {
    expect(() => parseWatchdogMessage({
      type: 'update', entries: [{ pid: 41, processStartTime: 1000, executableIdentity: 'id', signal: 'SIGKILL' }],
    })).toThrow(/unknown field/iu);
  });
});
