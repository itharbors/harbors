# Architecture Hardening 03: Session Lifecycle and HTTP Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Session runtime a complete disposal lifecycle and every JSON API a bounded, consistent error boundary.

**Architecture:** Add `Editor.dispose()` as the owner of module cleanup, then coordinate persistent sessions and Editor instances through `SessionRuntimeRegistry`. Move request parsing and response formatting to shared HTTP utilities with typed errors, and route Session creation/deletion through the registry.

**Tech Stack:** Node.js HTTP, TypeScript, SQLite via better-sqlite3, Vitest

## Global Constraints

- `Editor.dispose()` is idempotent and continues best-effort cleanup after individual failures.
- A disposed or unusable Editor cannot accept new mutating operations.
- JSON request bodies are limited to 1 MiB.
- Error responses use `{ error: { code, message, details } }`.
- Session deletion removes an unusable runtime even if cleanup reports an error.

---

## File Structure

- `packages/server/src/editor/index.ts`: Editor disposal orchestration.
- `packages/server/src/editor/types.ts`: disposal and usability contract.
- `packages/server/src/session/runtime-registry.ts`: single coordinator for SessionManager and Editor instances.
- `packages/server/src/http/errors.ts`: stable typed HTTP errors.
- `packages/server/src/http/json.ts`: bounded body reading, JSON parsing and response writing.
- `packages/server/src/api/session.ts`: GET/POST/DELETE Session routes using shared utilities.
- `packages/server/src/routes/*.ts`: all JSON routes consume the same request/error utilities.
- `packages/server/src/app.ts`: constructs Editors through the registry and centralizes errors.
- `packages/server/src/server.ts`: shutdown ordering.
- `packages/server/tests/framework/editor.test.ts`: disposal behavior.
- `packages/server/tests/session/runtime-registry.test.ts`: create/destroy concurrency and cleanup.
- `packages/server/tests/api/session.test.ts`: request validation and DELETE API.
- `packages/server/tests/integration/integration.test.ts`: server shutdown and map removal.

### Task 1: Add idempotent Editor disposal

**Files:**
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/editor/index.ts`
- Test: `packages/server/tests/framework/editor.test.ts`

**Interfaces:**
- Produces: `Editor.dispose(): Promise<void>`.
- Consumes: `Editor.isUsable(): boolean` from the plugin/Kit plan, PluginModule unload/list operations, and module owner cleanup methods.

- [ ] **Step 1: Write disposal tests**

```ts
it('disposes loaded plugins and rejects later mutations', async () => {
  await editor.kit.load('default');
  expect(editor.plugin.listLoaded().length).toBeGreaterThan(0);

  await editor.dispose();
  await editor.dispose();

  expect(editor.plugin.listLoaded()).toEqual([]);
  expect(editor.isUsable()).toBe(false);
  await expect(editor.kit.load('default')).rejects.toThrow('Editor is unavailable');
});
```

Add a cleanup-failure test that makes one plugin unload throw and proves remaining plugins are still attempted; expect an `AggregateError` after cleanup.

- [ ] **Step 2: Run the focused test**

```bash
npm run test -w packages/server -- --run tests/framework/editor.test.ts
```

Expected: FAIL because `dispose` and `isUsable` do not exist.

- [ ] **Step 3: Implement the disposal state machine**

Use one shared promise:

```ts
let disposePromise: Promise<void> | undefined;

function dispose(): Promise<void> {
  if (disposePromise) return disposePromise;
  usable = false;
  disposePromise = disposeModules();
  return disposePromise;
}
```

`disposeModules()` unloads external then built-in plugins in reverse order, clears Menu/Message/Panel state and nulls WindowManager. Collect errors and throw one `AggregateError` only after all cleanup attempts.

- [ ] **Step 4: Run Editor tests**

```bash
npm run test -w packages/server -- --run tests/framework/editor.test.ts tests/integration/kit-switch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/editor/types.ts packages/server/src/editor/index.ts packages/server/tests/framework/editor.test.ts
git commit -m "feat: add editor disposal lifecycle"
```

### Task 2: Introduce SessionRuntimeRegistry

**Files:**
- Create: `packages/server/src/session/runtime-registry.ts`
- Create: `packages/server/tests/session/runtime-registry.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`

**Interfaces:**
- Produces: `get(id)`, `getOrCreate(id, options)`, `destroy(id)`, `disposeAll()`, and read-only `editors`.
- Consumes: `SessionManager`, async `createEditorRuntime(session, options)`, and `Editor.dispose()`.

- [ ] **Step 1: Write registry creation and deletion tests**

```ts
it('deduplicates concurrent runtime creation and destroys both runtime and session', async () => {
  const createRuntime = vi.fn(async () => createDisposableEditor());
  const registry = new SessionRuntimeRegistry(manager, createRuntime);

  const [first, second] = await Promise.all([
    registry.getOrCreate('same-session', {}),
    registry.getOrCreate('same-session', {}),
  ]);

  expect(first.editor).toBe(second.editor);
  expect(createRuntime).toHaveBeenCalledTimes(1);
  await registry.destroy('same-session');
  expect(first.editor.dispose).toHaveBeenCalledTimes(1);
  expect(manager.get('same-session')).toBeUndefined();
  expect(registry.get('same-session')).toBeUndefined();
});
```

Add tests for creation failure leaving no map entry and `disposeAll()` continuing after one disposal error.

- [ ] **Step 2: Run the registry test**

```bash
npm run test -w packages/server -- --run tests/session/runtime-registry.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement registry pending deduplication**

Use:

```ts
private readonly runtimes = new Map<string, Editor>();
private readonly pending = new Map<string, Promise<SessionRuntime>>();
```

`getOrCreate` checks `runtimes`, then `pending`, and deletes the pending entry in `finally`. Only store an Editor after creation and Kit loading succeed.

- [ ] **Step 4: Route app creation through the registry**

Replace direct `editorMap.has/set` logic with `registry.getOrCreate`. Preserve a read-only Map-compatible accessor in the server return value for existing integration tests until routes are migrated.

- [ ] **Step 5: Run registry and integration tests**

```bash
npm run test -w packages/server -- --run tests/session/runtime-registry.test.ts tests/integration/integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session/runtime-registry.ts packages/server/tests/session/runtime-registry.test.ts packages/server/src/app.ts packages/server/src/server.ts
git commit -m "feat: coordinate session runtimes in a registry"
```

### Task 3: Add bounded JSON utilities and typed HTTP errors

**Files:**
- Create: `packages/server/src/http/errors.ts`
- Create: `packages/server/src/http/json.ts`
- Create: `packages/server/tests/http/json.test.ts`
- Modify: `packages/server/src/app.ts`

**Interfaces:**
- Produces: `HttpError`, `readBody(req, options)`, `readJson(req, validate, options)`, `sendJson(res, status, value)`, `sendHttpError(res, error)`.
- Consumes: Node `IncomingMessage` and `ServerResponse`.

- [ ] **Step 1: Write request utility tests**

Cover valid JSON, empty body, invalid JSON, 1 MiB + 1 byte body, `aborted`, and stream `error`:

```ts
await expect(readJson(requestWith('{bad'), isRecord)).rejects.toMatchObject({
  status: 400,
  code: 'INVALID_JSON',
});

await expect(readBody(requestWith(Buffer.alloc(1024 * 1024 + 1)))).rejects.toMatchObject({
  status: 413,
  code: 'BODY_TOO_LARGE',
});
```

- [ ] **Step 2: Run the utility tests**

```bash
npm run test -w packages/server -- --run tests/http/json.test.ts
```

Expected: FAIL because the HTTP utility modules do not exist.

- [ ] **Step 3: Implement stable errors**

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}
```

`readBody` counts bytes during `data`, rejects and removes listeners on overflow/abort/error, and defaults to `1024 * 1024`. `readJson` catches only syntax errors as `INVALID_JSON`; validator failure is `INVALID_REQUEST`.

- [ ] **Step 4: Add one application error boundary**

At the top HTTP handler, map known `HttpError` values with:

```ts
sendJson(res, error.status, {
  error: { code: error.code, message: error.message, details: error.details },
});
```

Map unknown errors to status 500 and code `INTERNAL_ERROR` after logging the original error.

- [ ] **Step 5: Run HTTP utility and route tests**

```bash
npm run test -w packages/server -- --run tests/http/json.test.ts tests/integration/routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/errors.ts packages/server/src/http/json.ts packages/server/tests/http/json.test.ts packages/server/src/app.ts
git commit -m "feat: standardize bounded json requests"
```

### Task 4: Migrate Session routes and add DELETE

**Files:**
- Modify: `packages/server/src/api/session.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/tests/api/session.test.ts`
- Test: `packages/server/tests/integration/integration.test.ts`

**Interfaces:**
- Produces: `DELETE /api/session/:id` with 204/404/500 semantics.
- Consumes: SessionRuntimeRegistry and shared HTTP utilities.

- [ ] **Step 1: Add DELETE and validation tests**

```ts
const deleteResponse = await fetch(`${baseURL}/api/session/delete-me`, { method: 'DELETE' });
expect(deleteResponse.status).toBe(204);
expect(server.manager.get('delete-me')).toBeUndefined();
expect(server.editorMap.has('delete-me')).toBe(false);

const missingResponse = await fetch(`${baseURL}/api/session/delete-me`, { method: 'DELETE' });
expect(missingResponse.status).toBe(404);
expect(await missingResponse.json()).toMatchObject({
  error: { code: 'SESSION_NOT_FOUND' },
});
```

Also POST invalid JSON and an oversized body, expecting 400 `INVALID_JSON` and 413 `BODY_TOO_LARGE`.

- [ ] **Step 2: Run Session API tests**

```bash
npm run test -w packages/server -- --run tests/api/session.test.ts tests/integration/integration.test.ts
```

Expected: new tests FAIL.

- [ ] **Step 3: Implement typed Session parsing**

Validate `sessionId`, `workspacePath`, `kit`, `kitName`, `kitPath`, and `locale` as optional strings. Reject other types with `HttpError(400, 'INVALID_REQUEST', ...)`.

- [ ] **Step 4: Implement DELETE through the registry**

Use:

```ts
if (deleteMatch && method === 'DELETE') {
  const deleted = await registry.destroy(decodeURIComponent(deleteMatch[1]));
  if (!deleted) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  res.statusCode = 204;
  res.end();
  return;
}
```

- [ ] **Step 5: Implement shutdown ordering**

`stop()` first prevents new work, then awaits `registry.disposeAll()`, closes request/SSE infrastructure, closes the store, and finally resolves after `server.close` callback. Preserve cleanup errors with `AggregateError` after attempting every step.

- [ ] **Step 6: Run Session and full server tests**

```bash
npm run test -w packages/server
```

Expected: all server tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/api/session.ts packages/server/src/app.ts packages/server/src/server.ts packages/server/tests/api/session.test.ts packages/server/tests/integration/integration.test.ts
git commit -m "feat: complete session http lifecycle"
```

### Task 5: Migrate every JSON route to the shared boundary

**Files:**
- Modify: `packages/server/src/routes/i18n.ts`
- Modify: `packages/server/src/routes/menu-trigger.ts`
- Modify: `packages/server/src/routes/message-request.ts`
- Modify: `packages/server/src/routes/message-broadcast.ts`
- Modify: `packages/server/src/routes/panel-open.ts`
- Modify: `packages/server/src/routes/panel-instance.ts`
- Modify: `packages/server/src/routes/window-group.ts`
- Modify: `packages/server/src/routes/utils.ts`
- Test: `packages/server/tests/integration/routes.test.ts`

**Interfaces:**
- Produces: one JSON parsing and error model across all API routes.
- Consumes: `readJson`, `sendJson`, `HttpError`, and the top-level application error boundary from Task 3.

- [ ] **Step 1: Add a route error matrix**

Use a table-driven integration test:

```ts
it.each([
  ['/api/menu/trigger', '{bad'],
  ['/api/message/request', '{bad'],
  ['/api/message/broadcast', '{bad'],
  ['/api/panel/open', '{bad'],
  ['/api/panel-instance/close', '{bad'],
  ['/api/window-group/close', '{bad'],
  ['/api/i18n?sessionId=s', '{bad'],
])('returns INVALID_JSON for %s', async (url, body) => {
  const response = await fetch(`${baseURL}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
});
```

Add a message handler that throws `new Error('handler exploded')`; assert `/api/message/request` returns 500 `INTERNAL_ERROR`, not 404. Keep a missing message route assertion at 404 `MESSAGE_ROUTE_NOT_FOUND`.

- [ ] **Step 2: Run route integration tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts
```

Expected: FAIL because routes still parse JSON independently and message errors collapse to 404.

- [ ] **Step 3: Replace route-local body parsing**

Each route calls `readJson(req, validator)` and throws `HttpError` for missing Session/resources. Remove imports of `readBody` from `api/session.ts` and remove local `try { JSON.parse(...) }` blocks.

Use route-specific validators that return narrowed objects, for example:

```ts
const input = await readJson(req, (value): value is MessageRequestInput => (
  isRecord(value)
  && typeof value.sessionId === 'string'
  && typeof value.plugin === 'string'
  && typeof value.name === 'string'
  && Array.isArray(value.args)
));
```

- [ ] **Step 4: Preserve domain error meaning**

Translate known lookup failures at the point where context exists:

```ts
if (!editor) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
if (!route) throw new HttpError(404, 'MESSAGE_ROUTE_NOT_FOUND', 'Message route not found');
```

Allow unexpected handler errors to reach the top-level 500 boundary. Use 409 for invalid current-state transitions such as operating on a closed Panel instance.

- [ ] **Step 5: Delete obsolete route response helpers**

If `routes/utils.ts` only duplicates `sendJson`, replace all imports with `http/json.ts` and delete it. Otherwise keep only non-JSON route helpers and rename them by responsibility.

- [ ] **Step 6: Run all route and server tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts tests/api/session.test.ts
npm run test -w packages/server
```

Expected: both commands PASS.

- [ ] **Step 7: Verify raw JSON parsing is gone from HTTP routes**

```bash
rg -n "JSON\.parse\(\(await readBody|from '../api/session'" packages/server/src/api packages/server/src/routes
```

Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/routes packages/server/tests/integration/routes.test.ts
git commit -m "refactor: standardize json api routes"
```
