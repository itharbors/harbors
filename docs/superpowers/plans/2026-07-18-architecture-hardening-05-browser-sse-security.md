# Architecture Hardening 05: Browser Requests, SSE, and Panel Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete browser-targeted request/response delivery, make SSE connection cleanup reliable, and constrain Panel iframe capabilities.

**Architecture:** Replace the generic EventBus pending map with a session-aware BrowserRequestBroker injected into MessageModule. Deliver requests through versioned SSE, relay iframe dispatch results through the host client, and reject pending work on timeout, disconnect, Session deletion or shutdown. Add an explicit minimal iframe sandbox while retaining same-origin Panel assets.

**Tech Stack:** Node.js HTTP/SSE, browser EventSource/postMessage/fetch, TypeScript, Vitest/jsdom

## Global Constraints

- Browser request timeout is 10 seconds.
- Request results are accepted only for the Session that owns the request ID.
- Duplicate and late results never complete an old Promise.
- SSE heartbeat interval is 15 seconds.
- Each SSE connection buffers at most 64 business events while waiting for `drain`; heartbeats are never queued.
- No offline SSE replay or persistent queue is added.
- Panel iframe sandbox is exactly `allow-scripts allow-same-origin` in this phase.

---

## File Structure

- `packages/server/src/framework/browser-request-broker.ts`: session-aware pending browser requests.
- `packages/server/src/framework/message/index.ts`: delegates browser routes through an injected dispatcher.
- `packages/server/src/sse/channel.ts`: connections, write failure reporting and close APIs.
- `packages/server/src/sse/handler.ts`: 15-second heartbeat and complete event cleanup.
- `packages/server/src/routes/message-result.ts`: validates and resolves session-owned results.
- `packages/server/src/app.ts`: wires broker, SSE and each Editor.
- `packages/server/src/server.ts`: broker/channel shutdown.
- `packages/client/src/core/transport.ts`: posts dispatch results.
- `packages/client/src/components/editor-app.ts`: receives iframe `dispatch-result` and relays it.
- `packages/server/src/routes/panel-asset.ts`: versioned iframe dispatch bridge payloads.
- `packages/client/src/layout/panel.ts`: iframe sandbox.
- Server and client tests: success, error, timeout, disconnect, duplicate result, heartbeat and sandbox.

### Task 1: Implement a session-aware BrowserRequestBroker

**Files:**
- Create: `packages/server/src/framework/browser-request-broker.ts`
- Create: `packages/server/tests/framework/browser-request-broker.test.ts`
- Modify: `packages/server/src/framework/message/index.ts`
- Modify: `packages/server/tests/framework/message.test.ts`

**Interfaces:**
- Produces: `request(sessionId, dispatch, target, timeoutMs?)`, `resolve(sessionId, requestId, result)`, `rejectSession(sessionId, reason)`, `destroy()`.
- Consumes: `dispatch(event: BrowserRequestEvent): void` supplied by SSE wiring.

- [ ] **Step 1: Write broker lifecycle tests**

```ts
it('resolves only from the owning session and rejects late results', async () => {
  vi.useFakeTimers();
  const dispatch = vi.fn();
  const broker = new BrowserRequestBroker();
  const pending = broker.request('session-a', dispatch, {
    panel: '@ce/log.log', method: 'getLogs', args: [],
  });
  const requestId = dispatch.mock.calls[0][0].requestId;

  expect(broker.resolve('session-b', requestId, { ok: true, value: [] })).toBe('wrong-session');
  expect(broker.resolve('session-a', requestId, { ok: true, value: ['ok'] })).toBe('resolved');
  await expect(pending).resolves.toEqual(['ok']);
  expect(broker.resolve('session-a', requestId, { ok: true, value: [] })).toBe('missing');
});
```

Add tests for 10-second timeout, `{ ok: false }`, `rejectSession`, and `destroy`, each asserting the pending count returns to zero.

- [ ] **Step 2: Run broker tests**

```bash
npm run test -w packages/server -- --run tests/framework/browser-request-broker.test.ts
```

Expected: FAIL because the broker does not exist.

- [ ] **Step 3: Implement pending ownership and cleanup**

Store:

```ts
interface PendingBrowserRequest {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
```

Generate IDs with `randomUUID()`, default timeout to `10_000`, delete before resolving/rejecting, and return the status union `'resolved' | 'wrong-session' | 'missing'` from `resolve`.

- [ ] **Step 4: Inject browser dispatch into MessageModule**

Extend options:

```ts
dispatchBrowserRequest?: (
  panel: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;
```

For a browser route, resolve one `panel.<method>` target exactly as panel requests already do. Require the first argument to be a panel key, remove it from method args, and return `dispatchBrowserRequest(...)`. If the route has no browser-dispatchable method, throw a descriptive registration/dispatch error.

- [ ] **Step 5: Run broker and MessageModule tests**

```bash
npm run test -w packages/server -- --run tests/framework/browser-request-broker.test.ts tests/framework/message.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/framework/browser-request-broker.ts packages/server/src/framework/message/index.ts packages/server/tests/framework/browser-request-broker.test.ts packages/server/tests/framework/message.test.ts
git commit -m "feat: broker browser targeted requests"
```

### Task 2: Wire browser request results through SSE and HTTP

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/message-result.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/client/src/core/transport.ts`
- Modify: `packages/client/src/components/editor-app.ts`
- Modify: `packages/server/src/routes/panel-asset.ts`
- Test: `packages/server/tests/integration/routes.test.ts`
- Test: `packages/client/tests/core/transport.test.ts`
- Test: `packages/client/tests/components/editor-app.test.ts`

**Interfaces:**
- Produces: `EditorTransport.sendMessageResult(requestId, result): Promise<void>` and `POST /api/message/result` with Session ownership.
- Consumes: BrowserRequestBroker and shared protocol message result DTOs.

- [ ] **Step 1: Add end-to-end server route tests**

Register a browser route, call `editor.message.request`, capture the SSE event, and POST:

```ts
const response = await fetch(`${baseURL}/api/message/result`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId,
    requestId: dispatch.requestId,
    result: { ok: true, value: 'browser-value' },
  }),
});

expect(response.status).toBe(204);
await expect(pending).resolves.toBe('browser-value');
```

Also POST with another Session and a duplicate request ID, expecting 409 `REQUEST_SESSION_MISMATCH` and 404 `REQUEST_NOT_FOUND`.

- [ ] **Step 2: Add client relay tests**

Dispatch a `message` event from the matching iframe:

```ts
window.dispatchEvent(new MessageEvent('message', {
  source: iframe.contentWindow,
  data: { type: 'dispatch-result', requestId: 'req-1', result: 'ok' },
}));

expect(fetch).toHaveBeenCalledWith('/api/message/result', expect.objectContaining({
  method: 'POST',
  body: JSON.stringify({
    sessionId: 'existing-id',
    requestId: 'req-1',
    result: { ok: true, value: 'ok' },
  }),
}));
```

Add error-result coverage and prove messages from a Window that is not one of the rendered Panel iframes are ignored.

- [ ] **Step 3: Run focused tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts
npm run test -w packages/client -- --run tests/core/transport.test.ts tests/components/editor-app.test.ts
```

Expected: new result relay tests FAIL.

- [ ] **Step 4: Wire broker dispatch per Editor**

When creating an Editor, inject:

```ts
dispatchBrowserRequest: (panel, method, args) => broker.request(
  session.sessionId,
  (event) => channel.broadcast(session.sessionId, event),
  { panel, method, args },
),
```

Session deletion calls `broker.rejectSession(sessionId, new Error('Session destroyed'))` before closing its SSE connections.

- [ ] **Step 5: Validate and resolve HTTP results**

The route requires `sessionId`, `requestId`, and a discriminated result. Map broker statuses to 204, 409 `REQUEST_SESSION_MISMATCH`, and 404 `REQUEST_NOT_FOUND` using the shared HTTP utilities.

- [ ] **Step 6: Relay trusted iframe results in the client**

Add `EditorTransport.sendMessageResult`. EditorApp registers one `window.message` listener, confirms `event.source` belongs to a rendered Panel iframe, validates `requestId`, converts `{ result }` or `{ error }` to the shared result union, and posts it. Remove the listener in `disconnectedCallback`.

- [ ] **Step 7: Run focused tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts
npm run test -w packages/client -- --run tests/core/transport.test.ts tests/components/editor-app.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/routes/message-result.ts packages/server/src/server.ts packages/server/src/routes/panel-asset.ts packages/server/tests/integration/routes.test.ts packages/client/src/core/transport.ts packages/client/src/components/editor-app.ts packages/client/tests/core/transport.test.ts packages/client/tests/components/editor-app.test.ts
git commit -m "feat: complete browser request response flow"
```

### Task 3: Harden SSE lifecycle and backpressure failure handling

**Files:**
- Modify: `packages/server/src/sse/channel.ts`
- Modify: `packages/server/src/sse/handler.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/tests/sse/channel.test.ts`
- Test: `packages/server/tests/integration/routes.test.ts`

**Interfaces:**
- Produces: `closeSession(id)`, `closeAll()`, `onSessionDisconnected(listener)`, and broadcast write-failure cleanup.
- Consumes: BrowserRequestBroker `rejectSession`.

- [ ] **Step 1: Add connection cleanup tests**

```ts
it('removes failed writers and closes every connection for a session', () => {
  const good = createResponse();
  const failed = createResponse({ writeError: new Error('socket closed') });
  channel.addClient('s', good);
  channel.addClient('s', failed);

  channel.broadcast('s', connectedEvent('s'));
  expect(channel.clientCount('s')).toBe(1);

  channel.closeSession('s');
  expect(good.end).toHaveBeenCalled();
  expect(channel.clientCount('s')).toBe(0);
});
```

Use fake timers in the handler test and advance 15 seconds, expecting `: heartbeat <timestamp>\n\n`. Add a response whose first `write()` returns `false`; prove later business events wait for `drain`, preserve order, and that the 65th queued event closes the connection and emits the disconnect notification.

- [ ] **Step 2: Run SSE tests**

```bash
npm run test -w packages/server -- --run tests/sse/channel.test.ts tests/integration/routes.test.ts
```

Expected: FAIL for missing close/count APIs or the 30-second heartbeat.

- [ ] **Step 3: Implement complete connection records**

Store response, a `blocked` flag, a `string[]` queue and cleanup callbacks in a `ClientConnection`. Catch synchronous `write` errors, listen for response `error/close` and request `aborted/close`, and make cleanup idempotent. When `write()` returns `false`, enqueue at most 64 later business events and flush them in order on `drain`; skip heartbeats while blocked. Close and clean the connection if the queue would exceed 64.

- [ ] **Step 4: Change heartbeat and shutdown semantics**

Write SSE heartbeats as comments every `15_000` ms. `closeSession` ends each response and emits one session-disconnected notification after the final connection disappears. `closeAll` cancels all timers and closes all responses.

- [ ] **Step 5: Reject pending browser requests on disconnect**

Wire `channel.onSessionDisconnected((id) => broker.rejectSession(id, new Error('Browser disconnected')))` and call `channel.closeAll()` during server shutdown.

- [ ] **Step 6: Run SSE and browser request suites**

```bash
npm run test -w packages/server -- --run tests/sse/channel.test.ts tests/framework/browser-request-broker.test.ts tests/integration/routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/sse/channel.ts packages/server/src/sse/handler.ts packages/server/src/app.ts packages/server/src/server.ts packages/server/tests/sse/channel.test.ts packages/server/tests/integration/routes.test.ts
git commit -m "fix: harden sse connection lifecycle"
```

### Task 4: Add the minimal Panel iframe sandbox

**Files:**
- Modify: `packages/client/src/layout/panel.ts`
- Modify: `packages/client/tests/layout/panel.test.ts`
- Modify: `packages/client/tests/pages/layout-kit.test.ts`

**Interfaces:**
- Produces: every rendered Panel iframe with sandbox tokens `allow-scripts allow-same-origin`.
- Consumes: same-origin Panel asset URLs and the existing postMessage bridge.

- [ ] **Step 1: Write exact sandbox tests**

```ts
const iframe = panel.shadowRoot!.querySelector('iframe')!;
expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
expect(Array.from(iframe.sandbox)).toEqual(['allow-scripts', 'allow-same-origin']);
```

Keep an integration assertion that the mixed simple/iframe example still renders its iframe and URL.

- [ ] **Step 2: Run Panel tests**

```bash
npm run test -w packages/client -- --run tests/layout/panel.test.ts tests/pages/layout-kit.test.ts
```

Expected: FAIL because `sandbox` is absent.

- [ ] **Step 3: Add the exact sandbox attribute**

Render:

```html
<iframe
  src="${escapeAttr(src!)}"
  sandbox="allow-scripts allow-same-origin"
  allowtransparency="true"
></iframe>
```

Do not add `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-downloads`, or Pointer Lock permissions.

- [ ] **Step 4: Run Panel and EditorApp tests**

```bash
npm run test -w packages/client -- --run tests/layout/panel.test.ts tests/pages/layout-kit.test.ts tests/components/editor-app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/layout/panel.ts packages/client/tests/layout/panel.test.ts packages/client/tests/pages/layout-kit.test.ts
git commit -m "security: sandbox panel iframes"
```

### Task 5: Run the complete architecture-hardening audit

**Files:**
- Modify: `docs/architecture/plugin-runtime-model.md`
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `docs/guides/development-workflow.md`

**Interfaces:**
- Consumes: all deliverables from plans 01 through 05.
- Produces: current documentation and authoritative full-suite verification.

- [ ] **Step 1: Update documentation to match implemented names and flows**

Document `SessionRuntimeRegistry`, `Editor.dispose`, Kit rollback, `PROTOCOL_VERSION`, BrowserRequestBroker, 10-second request timeout, 15-second SSE heartbeat, and trusted-plugin security boundary. Remove statements that still describe raw `editorMap` ownership or incomplete browser requests.

- [ ] **Step 2: Scan required invariants**

```bash
rg -n "scene-editor|kit-scene-editor" . --glob '!docs/superpowers/**' --glob '!node_modules/**' --glob '!package-lock.json' --glob '!**/dist/**'
rg -n "globalScope\.editor|globalThis\.editor" packages/server/src/framework/plugin
rg -n "<iframe" packages/client/src/layout/panel.ts
```

Expected: no scene-editor matches; global editor access exists only inside the locked definition-capture function; iframe includes the exact sandbox.

- [ ] **Step 3: Run full verification**

```bash
npm run check
```

Expected: command terminates with exit code 0 after server tests, client tests and plugin checks.

- [ ] **Step 4: Review repository status**

```bash
git status --short
git diff --check
```

Expected: no uncommitted architecture-hardening changes; unrelated pre-existing migration changes remain distinguishable and untouched.

- [ ] **Step 5: Commit documentation corrections if any**

```bash
git add docs/architecture docs/guides/development-workflow.md
git commit -m "docs: record architecture hardening behavior"
```
