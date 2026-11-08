import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('mounted panel keeps a cached draft when the initial getState snapshot is stale', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback): number => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (handle: number): void => dom.window.clearTimeout(handle);
  const globalKeys = ['window', 'document', 'HTMLElement'] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });

  const { default: panel } = await import('../dist/index.js');
  const requests: string[] = [];
  let releaseSnapshot!: (value: unknown) => void;
  const initialSnapshot = new Promise<unknown>((resolve) => { releaseSnapshot = resolve; });
  let snapshotProcessed = false;
  let staleStateApplied = false;
  let stateRequests = 0;
  const previousConsoleError = console.error;
  const stateErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === 'string' && arg.includes('加载对话界面状态失败'))) stateErrors.push(args);
    else previousConsoleError(...args);
  };
  const context = {
    message: {
      async request(_plugin: string, name: string): Promise<unknown> {
        requests.push(name);
        if (name === 'getState') {
          if (stateRequests++ === 0) return initialSnapshot;
          return { selectedConversationId: null, draft: null, generation: 'reloaded-generation', revision: 0 };
        }
        return {};
      },
    },
  };

  try {
    await panel.mount(context);
    // The real bridge can deliver this broadcast while React is still mounting.
    // registerSetter replays it, then getState returns the older empty snapshot.
    panel.methods.onConversationSelected({
      selectedConversationId: null,
      draft: { source: 'harbors', project: '/workspace/draft' },
      generation: 'draft-generation',
      revision: 1,
    });
    await waitFor(() => requests.includes('getState') && Boolean(document.querySelector('.message-input-container textarea')), 'cached draft and getState');
    releaseSnapshot({
      generation: 'reloaded-generation',
      get revision() { queueMicrotask(() => { snapshotProcessed = true; }); return 0; },
      get selectedConversationId() { staleStateApplied = true; return null; },
      draft: null,
    });
    await waitFor(() => snapshotProcessed, 'stale snapshot processed');
    assert.equal(staleStateApplied, false, 'stale snapshot must be rejected before applying its state');

    assert.ok(requests.includes('getState'));
    assert.ok(document.querySelector('.message-input-container'));
    assert.ok(document.querySelector('textarea'));
    assert.equal(document.querySelector('.empty-state'), null);

    panel.unmount();
    panel.unmount();
    assert.equal(dom.window.document.getElementById('panel-root')?.childElementCount, 0);

    await panel.mount(context);
    await waitFor(() => Boolean(document.querySelector('.empty-state')), 'empty state after remount');
    assert.ok(document.querySelector('.empty-state'), '重新挂载不应重放旧会话缓存');
    assert.equal(document.querySelector('textarea'), null);
    assert.deepEqual(stateErrors, [], '处理会话状态时不能吞掉错误');
  } finally {
    console.error = previousConsoleError;
    panel.unmount();
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

let streamFixtureSequence = 0;
const CONVERSATION_A = 'harbors:0fa427ba-2f4b-4107-a104-9f7c06479bb1';
const CONVERSATION_B = 'harbors:bd47ad51-17a3-4ec5-8dbc-0ae368fc84b0';

type Event = { seq: number; time: number; type: string; conversationId: string; turnId?: string; data: Record<string, unknown> };

function traceEvent(conversationId: string, seq: number, type: string, data: Record<string, unknown> = {}, turn = 1): Event {
  // Agent 路由 envelope/page 使用公开 ID；已持久化的 canonical 事件保留内部 adapter ID。
  const nativeId = conversationId.slice('harbors:'.length);
  return { seq, time: seq, type, conversationId: nativeId, turnId: `${nativeId}-turn-${turn}`, data: { conversationId: nativeId, turnId: `${nativeId}-turn-${turn}`, turn, step: 1, ...data } };
}

function itemEvent(conversationId: string, seq: number, phase: string, payload: unknown, turn = 1): Event {
  return traceEvent(conversationId, seq, `item/${phase}`, { itemId: `${conversationId}-assistant-${turn}`, item: { kind: 'message', phase, ...(phase === 'delta' ? { delta: payload } : { snapshot: payload }) } }, turn);
}

function initialTrace(conversationId: string, offset = 0, turn = 1): Event[] {
  return [
    traceEvent(conversationId, offset, 'turn/start', {}, turn),
    traceEvent(conversationId, offset + 1, 'user/message', { id: `${conversationId}-user-${turn}`, content: `question ${turn}` }, turn),
    traceEvent(conversationId, offset + 2, 'step/start', {}, turn),
    itemEvent(conversationId, offset + 3, 'started', { role: 'assistant', content: '' }, turn),
    traceEvent(conversationId, offset + 4, 'request/context', { model: 'test-model' }, turn),
  ];
}

async function waitFor(check: () => boolean, message = 'DOM condition'): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${message}; DOM=${document.body.textContent}`);
}

async function mountedChat(run: (fixture: {
  panel: typeof import('../dist/index.js')['default'];
  traces: Map<string, Event[]>;
  append: (event: Event) => void;
  select: (id: string, running?: boolean) => void;
  remount: () => Promise<void>;
  delayPage: (id: string) => () => void;
}) => Promise<void>, events = initialTrace(CONVERSATION_A)): Promise<void> {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback): number => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (handle: number): void => dom.window.clearTimeout(handle);
  const keys = ['window', 'document', 'HTMLElement'] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  // The browser bundle binds DOMPurify to its window at import time; each isolated DOM owns a fresh bundle.
  const { default: panel } = await import(`../dist/index.js?streamFixture=${++streamFixtureSequence}`);
  const traces = new Map<string, Event[]>([[CONVERSATION_A, events]]);
  const delayedPages = new Map<string, Promise<void>>();
  let selected = CONVERSATION_A;
  let running = true;
  let revision = 1;
  const uiState = () => ({ selectedConversationId: selected, running, generation: 'stream-test-generation', revision });
  const page = (id: string) => {
    const list = traces.get(id) || [];
    return { conversationId: id, events: [...list], cursor: list.at(-1)?.seq ?? -1, oldestSeq: list[0]?.seq ?? -1, hasMore: false, nextBeforeSeq: null };
  };
  const context = { message: { async request(_plugin: string, name: string, id: string, afterSeq: number): Promise<unknown> {
    if (name === 'getState') return uiState();
    if (name === 'getConversationTracePage') {
      await delayedPages.get(id);
      return page(id);
    }
    if (name === 'getConversationTraceSince') return { ...page(id), events: (traces.get(id) || []).filter((event) => event.seq > afterSeq) };
    if (name === 'getConversationOptions') return { models: [{ id: 'test-model', name: 'Test' }], selection: { model: 'test-model' } };
    if (name === 'getPendingPermissionRequests' || name === 'getMarkdownRenderers') return [];
    return {};
  } } };
  try {
    await panel.mount(context);
    await waitFor(() => document.querySelector('.agent-turn-header') !== null, 'initial trace loaded');
    await run({
      panel, traces,
      append(event) {
        const publicId = `harbors:${event.conversationId}`;
        const list = traces.get(publicId) || [];
        if (!list.some((existing) => existing.seq === event.seq)) traces.set(publicId, [...list, event]);
        panel.methods.onConversationTraceAppend({ conversationId: publicId, cursor: event.seq, event });
      },
      select(id, active = true) {
        selected = id; running = active; revision += 1;
        panel.methods.onConversationSelected(uiState());
      },
      async remount() { panel.unmount(); await panel.mount(context); },
      delayPage(id) {
        let release!: () => void;
        delayedPages.set(id, new Promise<void>((resolve) => { release = resolve; }));
        return () => { delayedPages.delete(id); release(); };
      },
    });
  } finally {
    panel.unmount();
    dom.window.close();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function responseTexts(): string[] {
  return [...document.querySelectorAll('.agent-preview-response .markdown-body, .agent-final-response .markdown-body')].map((element) => element.textContent?.trim() || '');
}

test('mounted Chat renders two committed prefixes in the main bubble and one authoritative final snapshot', async () => {
  await mountedChat(async ({ panel, append, remount, select }) => {
    append(itemEvent(CONVERSATION_A, 5, 'delta', { content: 'A' }));
    await waitFor(() => responseTexts().join() === 'A', 'first real DOM prefix');
    assert.match(document.querySelector('.assistant-label')?.textContent || '', /生成中/);
    append(itemEvent(CONVERSATION_A, 5, 'delta', { content: 'A' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(responseTexts(), ['A'], 'duplicate trace delivery must not append the prefix twice');
    document.querySelector<HTMLButtonElement>('.agent-turn-header')?.click();
    await waitFor(() => document.querySelector('.agent-step.collapsed') !== null, 'manual process collapse');
    append(itemEvent(CONVERSATION_A, 6, 'delta', { content: '**B**' }));
    await waitFor(() => responseTexts().join() === 'AB', 'second real DOM prefix');
    assert.equal(document.querySelector('.agent-preview-response strong')?.textContent, 'B', 'Markdown content must update with the second prefix');
    assert.match(document.querySelector('.agent-turn-status')?.textContent || '', /运行中/);
    panel.methods.onMessageDelta({ conversationId: CONVERSATION_A, messageId: 'msg-uncommitted', content: 'uncommitted duplicate' });
    append(traceEvent(CONVERSATION_A, 7, 'assistant/message', { itemId: `${CONVERSATION_A}-assistant-1`, message: { id: `${CONVERSATION_A}-assistant-1`, content: 'legacy full' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(responseTexts(), ['AB']);
    append(itemEvent(CONVERSATION_A, 8, 'completed', { role: 'assistant', content: 'authoritative ABC' }));
    append(traceEvent(CONVERSATION_A, 9, 'step/end'));
    append(traceEvent(CONVERSATION_A, 10, 'turn/end', { reason: { kind: 'completed' } }));
    await waitFor(() => document.querySelector('.agent-final-response') !== null && responseTexts().join() === 'authoritative ABC');
    assert.equal(document.querySelectorAll('.agent-preview-response').length, 0);
    assert.equal(document.querySelectorAll('.agent-final-response').length, 1);
    select(CONVERSATION_A, false);
    await remount();
    await waitFor(() => responseTexts().join() === 'authoritative ABC', 'final snapshot after remount');
    assert.equal(document.querySelectorAll('.agent-final-response').length, 1);
    // Continue an old conversation: old final stays, new prefixes attach to turn 2.
    select(CONVERSATION_A, true);
    for (const event of initialTrace(CONVERSATION_A, 11, 2)) append(event);
    append(itemEvent(CONVERSATION_A, 16, 'delta', { content: 'new A' }, 2));
    await waitFor(() => responseTexts().join('|') === 'authoritative ABC|new A');
    append(itemEvent(CONVERSATION_A, 17, 'delta', { content: 'B' }, 2));
    await waitFor(() => responseTexts().join('|') === 'authoritative ABC|new AB');
  });
});

test('mounted Chat restores active previews and clears the prior conversation before a delayed active page arrives', async () => {
  const events = [...initialTrace(CONVERSATION_A), itemEvent(CONVERSATION_A, 5, 'delta', { content: 'prefix A' })];
  await mountedChat(async ({ traces, panel, append, select, delayPage, remount }) => {
    await waitFor(() => responseTexts().join() === 'prefix A', 'preview restored on mount');
    traces.set(CONVERSATION_B, [...initialTrace(CONVERSATION_B), itemEvent(CONVERSATION_B, 5, 'delta', { content: 'prefix B' })]);
    const release = delayPage(CONVERSATION_B);
    select(CONVERSATION_B);
    await waitFor(() => document.querySelector('.conversation-loading') !== null, 'new active page pending');
    assert.deepEqual(responseTexts(), []);
    assert.doesNotMatch(document.body.textContent || '', /prefix A/);
    append(itemEvent(CONVERSATION_A, 6, 'delta', { content: ' late' }));
    panel.methods.onMessageDelta({ conversationId: CONVERSATION_A, messageId: 'msg-old', content: 'wrong conversation' });
    // A newer broadcast can beat the initial page; the merged page must retain it once.
    append(itemEvent(CONVERSATION_B, 6, 'delta', { content: ' grows' }));
    release();
    await waitFor(() => responseTexts().join() === 'prefix B grows');
    await remount();
    await waitFor(() => responseTexts().join() === 'prefix B grows', 'active remount uses committed trace');
    select(CONVERSATION_A);
    await waitFor(() => responseTexts().join() === 'prefix A late');
  }, events);
});

test('mounted cancelled and failed prefixes remain visibly unfinished after remount', async () => {
  for (const kind of ['cancelled', 'failed']) {
    await mountedChat(async ({ append, remount, select }) => {
      append(itemEvent(CONVERSATION_A, 5, 'delta', { content: 'unfinished' }));
      await waitFor(() => responseTexts().join() === 'unfinished');
      append(traceEvent(CONVERSATION_A, 6, 'turn/end', { reason: { kind } }));
      await waitFor(() => document.querySelector('.agent-turn-status')?.classList.contains(kind) === true);
      assert.match(document.querySelector('.assistant-label')?.textContent || '', /未完成/);
      assert.equal(document.querySelector('.agent-final-response'), null);
      append(itemEvent(CONVERSATION_A, 7, 'completed', { role: 'assistant', content: 'late success' }));
      select(CONVERSATION_A, false);
      await remount();
      await waitFor(() => responseTexts().join() === 'unfinished');
      assert.match(document.querySelector('.assistant-label')?.textContent || '', /未完成/);
      assert.equal(document.querySelector('.agent-final-response'), null);
    });
  }
});


test('real Web checkpoint restores native-ID prefix through the public conversation route', async () => {
  // 来自 01-new-A 的真实已提交事件；只省略 request/context 中与展示无关的审计字段。
  const captured = [
      {"type": "sandbox/mode","time": 1792665102603,"data": {"mode": "workspace-write","conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},"seq": 0,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "approval/policy","time": 1792665102604,"data": {"policy": "ask","conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},"seq": 1,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "turn/start","time": 1792665102619,"data": {"turn": 1,"model": "chat-stream-test","sandboxMode": "workspace-write","approvalPolicy": "ask","conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","seq": 2,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "item/started","time": 1792665102620,"data": {"turn": 1,"step": 0,"itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","item": {"kind": "message","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","phase": "started","snapshot": {"role": "user","content": "验证第一轮正文真正逐段显示"}},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","itemKind": "message","itemPhase": "started","seq": 3,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "user/message","time": 1792665102620,"data": {"turn": 1,"itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","content": [{"type": "text","text": "验证第一轮正文真正逐段显示"}],"source": {"kind": "user"},"role": "user","id": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","item": {"kind": "message","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","phase": "started"},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","itemKind": "message","itemPhase": "started","surfaceOp": "append","seq": 4,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "item/delta","time": 1792665102620,"data": {"turn": 1,"step": 0,"itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","item": {"kind": "message","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","phase": "delta","delta": {"content": "验证第一轮正文真正逐段显示"}},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","itemKind": "message","itemPhase": "delta","seq": 5,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "item/completed","time": 1792665102621,"data": {"turn": 1,"step": 0,"itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","item": {"kind": "message","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","phase": "completed","snapshot": {"role": "user","content": "验证第一轮正文真正逐段显示"}},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "1d27bb11-9fdd-401f-9cd5-5df4224e905a","itemKind": "message","itemPhase": "completed","seq": 6,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "session/title","time": 1792665102621,"data": {"title": "验证第一轮正文真正逐段显示","messageSeqs": [6],"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},"seq": 7,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "step/start","time": 1792665102623,"data": {"turn": 1,"step": 1,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","seq": 8,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "item/started","time": 1792665102626,"data": {"turn": 1,"step": 1,"itemId": "865c4e74-3961-4410-8add-762eed48f01d","item": {"kind": "message","itemId": "865c4e74-3961-4410-8add-762eed48f01d","phase": "started","snapshot": {"role": "assistant","content": ""}},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "865c4e74-3961-4410-8add-762eed48f01d","itemKind": "message","itemPhase": "started","seq": 9,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "request/context","time": 1792665102626,"data": {"turn": 1,"step": 1,"requestId": "02f49040-b365-4e31-9e0c-81134e99a84a","generation": "de492561-b074-4b00-8fc0-95a86c89af04","provider": "model-service","model": "chat-stream-test","conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","requestId": "02f49040-b365-4e31-9e0c-81134e99a84a","seq": 10,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
      {"type": "item/delta","time": 1792665102640,"data": {"turn": 1,"step": 1,"itemId": "865c4e74-3961-4410-8add-762eed48f01d","item": {"kind": "message","itemId": "865c4e74-3961-4410-8add-762eed48f01d","phase": "delta","delta": {"content": "初次前缀A，","requestId": "02f49040-b365-4e31-9e0c-81134e99a84a","generation": "de492561-b074-4b00-8fc0-95a86c89af04","sequence": 0}},"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1","turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89"},"turnId": "9e05cabf-f58e-4af0-8f43-fbc4ade41a89","itemId": "865c4e74-3961-4410-8add-762eed48f01d","itemKind": "message","itemPhase": "delta","seq": 11,"conversationId": "0fa427ba-2f4b-4107-a104-9f7c06479bb1"},
    ];
  await mountedChat(async ({ append, remount }) => {
    await waitFor(() => responseTexts().join() === '初次前缀A，', 'captured committed prefix');
    const last = captured.at(-1)! as Event;
    const item = last.data.item as Record<string, unknown>;
    append({ ...last, seq: 12, data: { ...last.data, item: { ...item, delta: { content: '第二段B。', sequence: 1 } } } });
    await waitFor(() => responseTexts().join() === '初次前缀A，第二段B。', 'captured item grows in the actual DOM');
    await remount();
    await waitFor(() => responseTexts().join() === '初次前缀A，第二段B。', 'native-ID trace survives remount');
  }, captured);
});
