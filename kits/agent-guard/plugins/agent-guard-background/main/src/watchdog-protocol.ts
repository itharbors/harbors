export interface WatchdogEntry {
  pid: number;
  processStartTime: number;
  executableIdentity: string;
}

export type WatchdogMessage =
  | { type: 'heartbeat' }
  | { type: 'update'; entries: WatchdogEntry[] }
  | { type: 'recover' }
  | { type: 'shutdown' };

type UnknownRecord = Record<string, unknown>;

export function parseWatchdogMessage(value: unknown): WatchdogMessage {
  const input = exactRecord(value, ['type'], 'watchdog message', true);
  if (input.type === 'heartbeat' || input.type === 'recover' || input.type === 'shutdown') {
    exactRecord(value, ['type'], 'watchdog message');
    return { type: input.type };
  }
  if (input.type !== 'update') throw new TypeError('watchdog message type is invalid');
  const update = exactRecord(value, ['type', 'entries'], 'watchdog update');
  if (!Array.isArray(update.entries) || update.entries.length > 256) {
    throw new TypeError('watchdog entries must be a bounded array');
  }
  return {
    type: 'update',
    entries: update.entries.map((value, index) => {
      const entry = exactRecord(
        value, ['pid', 'processStartTime', 'executableIdentity'], `watchdog entry ${index}`,
      );
      if (!Number.isSafeInteger(entry.pid) || (entry.pid as number) <= 1
        || !Number.isSafeInteger(entry.processStartTime) || (entry.processStartTime as number) < 0
        || typeof entry.executableIdentity !== 'string' || entry.executableIdentity.length === 0) {
        throw new TypeError(`watchdog entry ${index} is invalid`);
      }
      return {
        pid: entry.pid as number,
        processStartTime: entry.processStartTime as number,
        executableIdentity: entry.executableIdentity,
      };
    }),
  };
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  context: string,
  allowAdditional = false,
): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  const input = value as UnknownRecord;
  if (!allowAdditional) {
    const allowed = new Set(fields);
    const unknown = Object.keys(input).find((field) => !allowed.has(field));
    if (unknown) throw new TypeError(`${context} contains unknown field "${unknown}"`);
  }
  const missing = fields.find((field) => !(field in input));
  if (missing) throw new TypeError(`${context}.${missing} is required`);
  return input;
}
