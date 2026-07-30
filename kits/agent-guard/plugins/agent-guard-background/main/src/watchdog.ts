import type { WatchdogEntry } from './watchdog-protocol.js';

interface RecoveryWatchdogOptions {
  verify(entry: WatchdogEntry): Promise<boolean>;
  signal(pid: number, signal: 'SIGCONT'): void | Promise<void>;
}

export function createRecoveryWatchdog(options: RecoveryWatchdogOptions) {
  let entries: WatchdogEntry[] = [];
  let clean = false;
  let recovered = false;
  return {
    update(next: readonly WatchdogEntry[]) {
      if (clean || recovered) return;
      entries = next.slice(0, 256).map((entry) => ({ ...entry }));
    },
    heartbeat() {
      if (clean || recovered) return false;
      return true;
    },
    async cleanShutdown() {
      clean = true;
      entries = [];
    },
    async closeHeartbeatUnexpectedly() {
      if (clean || recovered) return;
      recovered = true;
      for (const entry of entries) {
        if (await options.verify(entry)) await options.signal(entry.pid, 'SIGCONT');
      }
      entries = [];
    },
  };
}
