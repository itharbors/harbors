export interface MessageDeltaUpdate {
  messageId: string;
  content: string;
  delta?: string;
  requestId?: string;
  generation?: string;
  sequence?: number;
}

export interface MessageSnapshot {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  turn?: number;
}

export type ScheduleFrame = (callback: () => void) => number;
export type CancelFrame = (handle: number) => void;
export type BottomScrollSignal = 'passive' | 'explicit-user';

export function shouldIgnorePendingBottomScroll(pending: boolean, signal: BottomScrollSignal): boolean {
  return pending && signal === 'passive';
}

function scheduleFrame(callback: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export function applyMessageDeltaUpdates(messages: readonly MessageSnapshot[], updates: readonly MessageDeltaUpdate[]): MessageSnapshot[] {
  if (updates.length === 0) return [...messages];
  const pending = new Map(updates.map((update) => [update.messageId, update]));
  const next = messages.map((message) => {
    const update = pending.get(message.id);
    if (!update) return message;
    pending.delete(message.id);
    return { ...message, content: update.content };
  });
  for (const update of pending.values()) {
    next.push({ id: update.messageId, role: 'assistant', content: update.content });
  }
  return next;
}

export function createMessageDeltaScheduler(
  onFlush: (updates: MessageDeltaUpdate[]) => void,
  schedule: ScheduleFrame = scheduleFrame,
  cancel: CancelFrame = cancelFrame,
) {
  const pending = new Map<string, MessageDeltaUpdate>();
  let frame: number | null = null;
  let generation = 0;
  const streamCursors = new Map<string, { requestId?: string; generation?: string; sequence: number; seenGenerations: Set<string> }>();

  const flush = (): void => {
    if (frame !== null) {
      generation += 1;
      cancel(frame);
      frame = null;
    }
    if (pending.size === 0) return;
    const updates = [...pending.values()];
    pending.clear();
    onFlush(updates);
  };

  const scheduleFlush = (): void => {
    if (frame !== null) return;
    const currentGeneration = generation;
    let callbackRan = false;
    const handle = schedule(() => {
      callbackRan = true;
      if (currentGeneration !== generation) return;
      frame = null;
      if (pending.size === 0) return;
      const updates = [...pending.values()];
      pending.clear();
      onFlush(updates);
    });
    frame = callbackRan ? null : handle;
  };

  return {
    enqueue(update: MessageDeltaUpdate): void {
      const cursor = streamCursors.get(update.messageId) || { sequence: -1, seenGenerations: new Set<string>() };
      if (update.generation !== undefined || update.sequence !== undefined || update.requestId !== undefined) {
        const sequenceValue = update.sequence;
        if (typeof update.generation !== 'string' || !update.generation || typeof update.requestId !== 'string' || !update.requestId || typeof sequenceValue !== 'number' || !Number.isSafeInteger(sequenceValue) || sequenceValue < 0) return;
        if (cursor.generation === update.generation && cursor.requestId && cursor.requestId !== update.requestId) return;
        if (cursor.generation && cursor.generation !== update.generation) {
          if (cursor.seenGenerations.has(update.generation)) return;
          cursor.requestId = update.requestId; cursor.generation = update.generation; cursor.sequence = -1;
        }
        if (!cursor.generation) { cursor.generation = update.generation; cursor.requestId = update.requestId; }
        const sequence = update.sequence;
        if (sequence === undefined || sequence !== cursor.sequence + 1) return;
        cursor.sequence = sequence; cursor.seenGenerations.add(update.generation);
        streamCursors.set(update.messageId, cursor);
      }
      pending.set(update.messageId, update);
      scheduleFlush();
    },
    flush,
    cancel(): void {
      generation += 1;
      if (frame !== null) cancel(frame);
      frame = null;
      pending.clear();
      streamCursors.clear();
    },
  };
}
