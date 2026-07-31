import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type { ParseWarning } from '@itharbors/traceweave-contracts';

export interface RawEvent {
  id: string;
  rawOffset: number;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ParsedRollout {
  sessionId: string;
  events: RawEvent[];
  warnings: ParseWarning[];
}

const knownRecordTypes = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'compacted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventId(sessionId: string, offset: number): string {
  return createHash('sha256').update(`${sessionId}:${offset}`).digest('hex').slice(0, 24);
}

export async function parseRollout(stream: Readable): Promise<ParsedRollout> {
  const pending: Omit<RawEvent, 'id'>[] = [];
  const warnings: ParseWarning[] = [];
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let sessionId: string | undefined;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      warnings.push({
        code: 'malformed_json',
        line: lineNumber,
        message: error instanceof Error ? error.message : 'Invalid JSON',
      });
      continue;
    }
    if (!isRecord(raw) || typeof raw.type !== 'string' || !isRecord(raw.payload)) {
      warnings.push({
        code: 'malformed_json',
        line: lineNumber,
        message: 'Invalid Codex event envelope',
      });
      continue;
    }
    const event = {
      rawOffset: lineNumber,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
      type: raw.type,
      payload: raw.payload,
      raw,
    };
    pending.push(event);
    if (event.type === 'session_meta') {
      const candidate = event.payload.session_id ?? event.payload.id;
      if (!sessionId && typeof candidate === 'string' && candidate.length > 0) sessionId = candidate;
    }
    if (!knownRecordTypes.has(event.type)) {
      warnings.push({
        code: 'unknown_event',
        line: lineNumber,
        eventType: event.type,
        message: `Unsupported Codex record type: ${event.type}`,
      });
    }
  }

  const resolvedSessionId = sessionId ?? 'unknown-session';
  return {
    sessionId: resolvedSessionId,
    events: pending.map(event => ({ ...event, id: eventId(resolvedSessionId, event.rawOffset) })),
    warnings,
  };
}
