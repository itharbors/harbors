import type { NeutralMessage, TraceEvent } from './types.js';

export function foldSurface(events: readonly TraceEvent[]): number[] {
  let surface: number[] = [];
  for (const event of events) surface = applySurfaceEvent(surface, event);
  return surface;
}

export function applySurfaceEvent(surface: readonly number[], event: TraceEvent): number[] {
  if (!isSurfaceEvent(event)) return [...surface];
  if (event.surfaceOp === undefined || event.surfaceOp === 'append') return [...surface, event.seq];
  const start = surface.indexOf(event.surfaceOp.start);
  const end = surface.indexOf(event.surfaceOp.end);
  if (start < 0 || end < start || event.surfaceOp.start >= event.seq || event.surfaceOp.end >= event.seq) {
    throw new Error('SURFACE_REFERENCE_INVALID');
  }
  return [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)];
}

export function messagesFromSurface(events: readonly TraceEvent[], surface: readonly number[]): NeutralMessage[] {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return surface.map((seq) => eventMessage(bySeq.get(seq))).filter((value): value is NeutralMessage => Boolean(value));
}

function isSurfaceEvent(event: TraceEvent): boolean {
  return event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result';
}

function eventMessage(event: TraceEvent | undefined): NeutralMessage | null {
  if (!event) throw new Error('SURFACE_EVENT_MISSING');
  const message = event.data.message;
  if (event.type === 'tool/result') {
    const value = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : {};
    const source = value.source && typeof value.source === 'object' ? value.source as Record<string, unknown> : {};
    const image = event.data.image && typeof event.data.image === 'object' ? event.data.image as Record<string, unknown> : undefined;
    const text = textContent(value.content);
    const content = image && typeof image.mediaType === 'string' && typeof image.base64 === 'string'
      ? [{ type: 'text', text }, { type: 'image', mediaType: image.mediaType, data: image.base64 }]
      : text;
    return { role: 'tool', toolCallId: String(source.callId ?? ''), content, ...(event.data.error ? { isError: true } : {}) };
  }
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const value = message as Record<string, unknown>;
    const role = value.role;
    if (role === 'user' || role === 'assistant' || role === 'tool') {
      const toolCalls = Array.isArray(value.tool_calls)
        ? value.tool_calls.flatMap((call) => {
            if (!call || typeof call !== 'object') return [];
            const item = call as Record<string, unknown>;
            const fn = item.function as Record<string, unknown> | undefined;
            return typeof item.id === 'string' && typeof fn?.name === 'string' && typeof fn.arguments === 'string'
              ? [{ id: item.id, name: fn.name, arguments: fn.arguments }]
              : [];
          })
        : undefined;
      return {
        role,
        content: value.content ?? '',
        ...(toolCalls?.length ? { toolCalls } : {}),
      };
    }
  }
  if (event.type === 'user/message') return { role: 'user', content: event.data.content ?? '' };
  return null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  return textContent(record.content);
}
