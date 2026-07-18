export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export function isSupportedProtocolVersion(value: unknown): value is ProtocolVersion {
  return value === PROTOCOL_VERSION;
}
