# Architecture Hardening 04: Shared Cross-Process Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@itharbors/plugin-types` the single source of truth for browser/server data and add explicit protocol-version validation.

**Architecture:** Move only serializable DTOs into focused protocol files, export a literal protocol version, and map server domain snapshots to those DTOs at transport boundaries. ClientSession and transports import shared DTOs instead of maintaining structurally similar interfaces.

**Tech Stack:** TypeScript project references via npm workspaces, Vite, Vitest

## Global Constraints

- The authoritative package name is `@itharbors/plugin-types`.
- Protocol version starts at the numeric literal `1`.
- Only serializable data enters the protocol package; runtime classes, functions and server paths remain local.
- Existing wire fields remain stable during the first migration step.
- Unsupported versions fail explicitly rather than being applied partially.

---

## File Structure

- `packages/plugin-types/src/protocol/version.ts`: protocol literal and guard.
- `packages/plugin-types/src/protocol/layout.ts`: Layout, Window and Panel instance DTOs.
- `packages/plugin-types/src/protocol/bootstrap.ts`: Session/bootstrap/menu/i18n DTOs.
- `packages/plugin-types/src/protocol/message.ts`: request/result/broadcast/SSE envelopes.
- `packages/plugin-types/src/protocol/http.ts`: stable API error body.
- `packages/plugin-types/src/index.ts`: public exports.
- `packages/plugin-types/package.json`: runtime and declaration export map.
- `packages/plugin-types/tsconfig.json`: emit JavaScript together with declarations.
- `packages/server/src/framework/window/types.ts`: aliases/imports shared layout DTOs while retaining internal input types.
- `packages/server/src/routes/bootstrap.ts`: creates versioned BootstrapInfo.
- `packages/client/src/core/session.ts`: removes duplicate protocol declarations.
- `packages/client/src/core/transport.ts`: validates protocol version.
- `packages/*/package.json`: workspace dependency declarations for client/server.
- Tests: protocol compile assertions, server bootstrap tests and client transport tests.

### Task 1: Define focused shared protocol DTOs

**Files:**
- Create: `packages/plugin-types/src/protocol/version.ts`
- Create: `packages/plugin-types/src/protocol/layout.ts`
- Create: `packages/plugin-types/src/protocol/bootstrap.ts`
- Create: `packages/plugin-types/src/protocol/message.ts`
- Create: `packages/plugin-types/src/protocol/http.ts`
- Modify: `packages/plugin-types/src/index.ts`
- Create: `packages/plugin-types/src/protocol/typecheck.ts`
- Modify: `packages/plugin-types/package.json`
- Modify: `packages/plugin-types/tsconfig.json`

**Interfaces:**
- Produces: `PROTOCOL_VERSION`, `ProtocolVersion`, `isSupportedProtocolVersion`, `BootstrapInfo`, `SSEEnvelope`, and related DTOs.
- Consumes: no server or client implementation types.

- [ ] **Step 1: Add a compile-time protocol contract**

Create `typecheck.ts` with representative assignments:

```ts
import type { BootstrapInfo } from './bootstrap';
import type { ApiErrorBody } from './http';
import type { SSEEnvelope } from './message';
import { PROTOCOL_VERSION } from './version';

const bootstrap: BootstrapInfo = {
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 'session',
  kitName: null,
  theme: {},
  windowEntries: null,
  windows: [],
  panelInstances: [],
  panels: [],
  menuTree: [],
  i18n: {
    locale: 'zh-CN',
    defaultLocale: 'zh-CN',
    version: 1,
    currentMessages: {},
    defaultMessages: {},
  },
};

const event: SSEEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'connected',
  sessionId: 'session',
};

const error: ApiErrorBody = {
  error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: null },
};

void [bootstrap, event, error];
```

- [ ] **Step 2: Run the package build and verify failure**

```bash
npm run build -w @itharbors/plugin-types
```

Expected: FAIL because protocol modules and exports do not exist.

- [ ] **Step 3: Implement version and layout DTOs**

Use:

```ts
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export function isSupportedProtocolVersion(value: unknown): value is ProtocolVersion {
  return value === PROTOCOL_VERSION;
}
```

Move the normalized `LayoutNode`, `WindowDescriptor`, `PanelInstanceDescriptor`, `WindowSnapshot`, `OpenPanelResult`, and serializable `PanelDescriptor` shapes into `layout.ts`. Do not move `LegacyWindowDescriptorInput`.

- [ ] **Step 4: Implement bootstrap, message and HTTP DTOs**

All transport envelopes include:

```ts
interface ProtocolEnvelope {
  protocolVersion: ProtocolVersion;
  type: string;
}
```

Define discriminated `SSEEnvelope` variants for connected, heartbeat, layout, menu, broadcast and browser-request events. Define result payloads with `{ ok: true; value } | { ok: false; error }`.

- [ ] **Step 5: Export and build**

Change `tsconfig.json` to emit executable ESM and declarations:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": false,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts"]
}
```

Expose both artifacts:

```json
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

Then run:

```bash
npm run build -w @itharbors/plugin-types
```

Expected: PASS and `packages/plugin-types/dist` contains JavaScript plus declarations for all protocol files.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-types/src packages/plugin-types/package.json packages/plugin-types/tsconfig.json
git commit -m "feat: define shared versioned protocol types"
```

### Task 2: Migrate server transport boundaries

**Files:**
- Modify: `packages/server/package.json`
- Modify: `package-lock.json`
- Modify: `packages/server/src/framework/window/types.ts`
- Modify: `packages/server/src/routes/bootstrap.ts`
- Modify: `packages/server/src/sse/channel.ts`
- Modify: `packages/server/tests/integration/routes.test.ts`
- Modify: `packages/server/tests/sse/channel.test.ts`

**Interfaces:**
- Consumes: shared protocol DTOs and `PROTOCOL_VERSION`.
- Produces: versioned bootstrap and SSE wire values.

- [ ] **Step 1: Add failing version assertions**

In bootstrap integration coverage:

```ts
expect(data.protocolVersion).toBe(1);
```

In SSE channel coverage:

```ts
expect(JSON.parse(writtenData).protocolVersion).toBe(1);
```

- [ ] **Step 2: Run focused server tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts tests/sse/channel.test.ts
```

Expected: FAIL because responses do not contain `protocolVersion`.

- [ ] **Step 3: Add the workspace dependency**

Add to server dependencies:

```json
"@itharbors/plugin-types": "0.0.1"
```

Run `npm install --package-lock-only` to update the workspace lock metadata without downloading new packages.

- [ ] **Step 4: Replace duplicated normalized types**

In window types, import and re-export shared DTOs:

```ts
import type {
  LayoutNode,
  OpenPanelResult,
  PanelInstanceDescriptor,
  WindowDescriptor,
  WindowSnapshot,
} from '@itharbors/plugin-types';

export type { LayoutNode, OpenPanelResult, PanelInstanceDescriptor, WindowDescriptor, WindowSnapshot };
```

Keep server-only legacy inputs in the server file.

- [ ] **Step 5: Version bootstrap and SSE output**

Construct bootstrap with `satisfies BootstrapInfo` and prepend `protocolVersion: PROTOCOL_VERSION`. Make `SSEChannel.broadcast` accept `SSEEnvelope` and serialize it without widening to arbitrary records.

- [ ] **Step 6: Run server typecheck and focused tests**

```bash
npm run test -w packages/server -- --run tests/integration/routes.test.ts tests/sse/channel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/src/framework/window/types.ts packages/server/src/routes/bootstrap.ts packages/server/src/sse/channel.ts packages/server/tests/integration/routes.test.ts packages/server/tests/sse/channel.test.ts
git commit -m "refactor: use shared protocol on server boundaries"
```

### Task 3: Migrate client protocol consumption and reject version mismatch

**Files:**
- Modify: `packages/client/package.json`
- Modify: `package-lock.json`
- Modify: `packages/client/src/core/session.ts`
- Modify: `packages/client/src/core/transport.ts`
- Modify: imports in `packages/client/src/components/editor-app.ts`
- Modify: imports in `packages/client/src/components/window-group-app.ts`
- Test: `packages/client/tests/core/transport.test.ts`
- Test: `packages/client/tests/core/session.test.ts`

**Interfaces:**
- Consumes: `BootstrapInfo`, `SSEEnvelope`, and `isSupportedProtocolVersion` from `@itharbors/plugin-types`.
- Produces: client state that only stores supported protocol data.

- [ ] **Step 1: Add mismatch tests**

```ts
it('rejects bootstrap from an unsupported protocol version', async () => {
  mockFetchJson({ protocolVersion: 2, sessionId: 's' });
  await expect(transport.getBootstrap('s')).rejects.toThrow('Unsupported protocol version: 2');
});

it('does not dispatch unsupported SSE events', () => {
  const listener = vi.fn();
  transport.subscribe(listener);
  emitSSE({ protocolVersion: 2, type: 'layout', sessionId: 's' });
  expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused client tests**

```bash
npm run test -w packages/client -- --run tests/core/transport.test.ts tests/core/session.test.ts
```

Expected: FAIL because version validation is absent.

- [ ] **Step 3: Add dependency and remove duplicates**

Add `"@itharbors/plugin-types": "0.0.1"` to client dependencies and update the lockfile. Replace DTO declarations in `core/session.ts` with type imports/re-exports, leaving only `ClientSession` as implementation state.

- [ ] **Step 4: Validate all incoming envelopes**

Use one helper:

```ts
function assertProtocolVersion(value: { protocolVersion?: unknown }): void {
  if (!isSupportedProtocolVersion(value.protocolVersion)) {
    throw new Error(`Unsupported protocol version: ${String(value.protocolVersion)}`);
  }
}
```

Call it immediately after JSON parsing and before mutating ClientSession or notifying SSE listeners. For EventSource callbacks, report the error through the existing transport error path and skip dispatch.

- [ ] **Step 5: Run client and shared package checks**

```bash
npm run build -w @itharbors/plugin-types
npm run test -w packages/client
```

Expected: PASS.

- [ ] **Step 6: Verify duplicate definitions are gone**

```bash
rg -n "^(export )?(interface|type) (BootstrapInfo|WindowDescriptor|PanelInstanceSnapshot|LayoutNode)" packages/client/src packages/server/src
```

Expected: only intentional server-only aliases or re-exports; no duplicate DTO bodies.

- [ ] **Step 7: Commit**

```bash
git add packages/client/package.json package-lock.json packages/client/src packages/client/tests/core/transport.test.ts packages/client/tests/core/session.test.ts
git commit -m "refactor: consume shared protocol in client"
```
