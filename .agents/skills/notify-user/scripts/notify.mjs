import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const VALUE_OPTIONS = new Map([
  ['--title', 'title'],
  ['--body', 'body'],
  ['--level', 'level'],
  ['--source', 'source'],
  ['--duration', 'durationMs'],
]);

export function parseNotifyArgs(args) {
  const input = { source: 'Codex' };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--persistent') {
      input.persistent = true;
      continue;
    }

    const field = VALUE_OPTIONS.get(argument);
    if (!field) {
      if (argument.startsWith('--')) {
        throw new Error(`Unknown option: ${argument}`);
      }
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;

    if (field === 'durationMs') {
      const durationMs = Number(value);
      if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 60000) {
        throw new Error('--duration must be between 1000 and 60000');
      }
      input.durationMs = durationMs;
      continue;
    }

    input[field] = value;
  }

  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new Error('--title is required');
  }
  if (input.level !== undefined && !LEVELS.has(input.level)) {
    throw new Error(`--level must be one of: ${Array.from(LEVELS).join(', ')}`);
  }
  return input;
}

export async function sendNotification(input, {
  port = process.env.HARBORS_NOTIFICATION_PORT || '17896',
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedPort = normalizePort(port);
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js runtime does not provide fetch');
  }

  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${normalizedPort}/v1/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new Error(
      `Desktop notification service is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const message = payload?.error?.message
      ?? `Notification Host returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (typeof payload?.id !== 'string' || payload.id.trim().length === 0) {
    throw new Error('Notification Host returned a success response without a notification id');
  }
  return payload;
}

function normalizePort(value) {
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Notification Host port must be an integer between 1 and 65535');
  }
  return port;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new Error(`Notification Host returned HTTP ${response.status}`);
    }
    throw new Error('Notification Host returned invalid JSON');
  }
}

async function main() {
  try {
    const input = parseNotifyArgs(process.argv.slice(2));
    const notification = await sendNotification(input);
    process.stdout.write(`Notification sent: ${notification.id}\n`);
  } catch (error) {
    process.stderr.write(`Notification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1]
  ? realpathSync(path.resolve(process.argv[1]))
  : null;

if (entryPath === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
