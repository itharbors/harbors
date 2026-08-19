export interface MessageDeltaUpdate {
  messageId: string;
  content: string;
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
    frame = schedule(() => {
      if (currentGeneration !== generation) return;
      frame = null;
      if (pending.size === 0) return;
      const updates = [...pending.values()];
      pending.clear();
      onFlush(updates);
    });
  };

  return {
    enqueue(update: MessageDeltaUpdate): void {
      pending.set(update.messageId, update);
      scheduleFlush();
    },
    flush,
    cancel(): void {
      generation += 1;
      if (frame !== null) cancel(frame);
      frame = null;
      pending.clear();
    },
  };
}
