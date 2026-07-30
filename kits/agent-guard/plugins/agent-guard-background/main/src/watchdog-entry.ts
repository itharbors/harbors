import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { createRecoveryWatchdog } from './watchdog.js';
import { parseWatchdogMessage, type WatchdogEntry } from './watchdog-protocol.js';

interface WatchdogEntryOptions {
  input: Readable;
  verify(entry: WatchdogEntry): Promise<boolean>;
  signal(pid: number, signal: 'SIGCONT'): void | Promise<void>;
}

export async function runWatchdogEntry(options: WatchdogEntryOptions): Promise<void> {
  const watchdog = createRecoveryWatchdog(options);
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let clean = false;
  try {
    for await (const line of lines) {
      const message = parseWatchdogMessage(JSON.parse(line));
      if (message.type === 'heartbeat') watchdog.heartbeat();
      if (message.type === 'update') watchdog.update(message.entries);
      if (message.type === 'shutdown') {
        clean = true;
        await watchdog.cleanShutdown();
        break;
      }
    }
  } finally {
    if (!clean) await watchdog.closeHeartbeatUnexpectedly();
  }
}
