import { types as utilTypes } from 'node:util';

const DEFAULT_PLUGIN_PROCESS_ERROR_MESSAGE = 'Application plugin runner failed';
const MAX_PLUGIN_PROCESS_ERROR_MESSAGE_LENGTH = 1024;

export function isPluginProcessProxy(input: unknown): boolean {
  if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return false;
  try {
    return utilTypes.isProxy(input);
  } catch {
    return true;
  }
}

export function normalizePluginProcessError(input: unknown): Error {
  let message = DEFAULT_PLUGIN_PROCESS_ERROR_MESSAGE;
  try {
    if (typeof input === 'string') {
      message = input;
    } else if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      message = String(input);
    } else if (input !== null && (typeof input === 'object' || typeof input === 'function')
      && !isPluginProcessProxy(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, 'message');
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') {
        message = descriptor.value;
      }
    }
  } catch {
    message = DEFAULT_PLUGIN_PROCESS_ERROR_MESSAGE;
  }
  return new Error((message || DEFAULT_PLUGIN_PROCESS_ERROR_MESSAGE).slice(0, MAX_PLUGIN_PROCESS_ERROR_MESSAGE_LENGTH));
}
