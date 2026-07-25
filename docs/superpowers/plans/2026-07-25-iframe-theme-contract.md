# iframe Theme Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove host-enforced iframe transparency, centralize iframe theme binding, validate Kit theme manifests, and keep Default Kit title/status surfaces dark.

**Architecture:** `ce-panel` becomes a pure iframe carrier and no longer mutates child documents. Theme tokens are applied through DOM style properties by focused client helpers, while `EditorApp` owns one binding per live iframe; the server normalizes the untyped manifest theme before it reaches the client.

**Tech Stack:** TypeScript, Web Components, CSS custom properties, Vitest, Node test runner, npm workspaces

## Global Constraints

- Work only in `/Users/bytedance/Project/harbors/.worktrees/bug-iframe-theme-contract` on `bug/iframe-theme-contract`.
- Follow red-green-refactor: every production behavior change starts with a failing focused test.
- Do not migrate unrelated hardcoded colors or change layout/accessibility contracts in this PR.
- Do not add dependencies or change the Kit theme JSON shape.
- Every commit title uses `[Bug]` plus a concise Chinese summary without a trailing period.
- Stage only the files named by the current task; never use `git add .`.

---

### Task 1: Stop `ce-panel` from mutating iframe documents

**Files:**
- Modify: `packages/client/tests/layout/panel.test.ts:50-67`
- Modify: `packages/client/src/layout/panel.ts:168-207`

**Interfaces:**
- Consumes: existing `<ce-panel src="...">` rendering contract.
- Produces: `ce-panel` owns only iframe element chrome; it never writes into `contentDocument`.

- [ ] **Step 1: Replace the old transparency test with a failing ownership test**

```ts
it('does not override the iframe document background', () => {
  const el = document.createElement('ce-panel') as Panel;
  el.setAttribute('src', '/editor');
  document.body.appendChild(el);

  const iframe = el.shadowRoot!.querySelector('iframe') as HTMLIFrameElement;
  const iframeDocument = document.implementation.createHTMLDocument('panel');
  iframeDocument.documentElement.style.background = 'rgb(24, 24, 24)';
  iframeDocument.body.style.background = 'rgb(32, 32, 32)';
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    value: iframeDocument,
  });

  iframe.dispatchEvent(new Event('load'));

  expect(iframeDocument.documentElement.style.background).toBe('rgb(24, 24, 24)');
  expect(iframeDocument.body.style.background).toBe('rgb(32, 32, 32)');
  expect(iframeDocument.getElementById('ce-panel-transparent-frame')).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test -w packages/client -- packages/client/tests/layout/panel.test.ts`

Expected: FAIL because the current `syncIframeTransparency()` replaces both backgrounds and creates `ce-panel-transparent-frame`.

- [ ] **Step 3: Remove the document mutation path**

Delete the `this.syncIframeTransparency()` call and the `syncIframeTransparency()` method from `Panel`. Keep the iframe element CSS background and sandbox attributes unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test -w packages/client -- packages/client/tests/layout/panel.test.ts`

Expected: PASS with no warnings or failures.

- [ ] **Step 5: Commit the isolated change**

```bash
git add packages/client/tests/layout/panel.test.ts packages/client/src/layout/panel.ts
git commit -m "[Bug] 停止宿主改写面板文档背景"
```

---

### Task 2: Apply theme tokens safely and bind iframe themes once

**Files:**
- Modify: `packages/client/tests/styles/theme.test.ts`
- Modify: `packages/client/src/styles/theme.ts`
- Modify: `packages/client/src/styles/tokens.css`
- Modify: `packages/client/src/styles/iframe-theme.ts`

**Interfaces:**
- Produces: `applyThemeTokensToElement(element: HTMLElement, tokens: ThemeTokens): void`.
- Produces: `bindThemeToIframe(iframe: HTMLIFrameElement, getTokens: () => ThemeTokens): () => void`.
- Preserves: `applyThemeToDocument(document: Document, tokens?: ThemeTokens): void` for direct application and tests.

- [ ] **Step 1: Add failing tests for the default scheme and safe token application**

Update the default-token assertion to include:

```ts
'--ce-color-scheme': 'dark',
```

Replace the `renderThemeVariables` tests with:

```ts
describe('applyThemeTokensToElement', () => {
  it('sets theme tokens as DOM style properties and removes stale managed tokens', () => {
    const element = document.createElement('div');
    applyThemeTokensToElement(element, {
      '--ce-accent': '#55aaff',
      '--ce-workbench-bg': '#111111',
    });
    applyThemeTokensToElement(element, {
      '--ce-accent': '#ff00aa',
    });

    expect(element.style.getPropertyValue('--ce-accent')).toBe('#ff00aa');
    expect(element.style.getPropertyValue('--ce-workbench-bg')).toBe('');
  });
});
```

Update `applyThemeToDocument` assertions so tokens are read from `document.documentElement.style`, no `ce-theme-tokens` style exists, and base CSS contains `color-scheme: var(--ce-color-scheme, dark);`.

- [ ] **Step 2: Add a failing iframe binding lifecycle test**

```ts
describe('bindThemeToIframe', () => {
  it('applies on load and stops applying after cleanup', () => {
    const iframe = document.createElement('iframe');
    const iframeDocument = document.implementation.createHTMLDocument('panel');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: iframeDocument });
    let accent = '#55aaff';
    const cleanup = bindThemeToIframe(iframe, () => ({ '--ce-accent': accent }));

    expect(iframeDocument.documentElement.style.getPropertyValue('--ce-accent')).toBe('#55aaff');
    accent = '#ff00aa';
    iframe.dispatchEvent(new Event('load'));
    expect(iframeDocument.documentElement.style.getPropertyValue('--ce-accent')).toBe('#ff00aa');

    cleanup();
    accent = '#00ffaa';
    iframe.dispatchEvent(new Event('load'));
    expect(iframeDocument.documentElement.style.getPropertyValue('--ce-accent')).toBe('#ff00aa');
  });
});
```

- [ ] **Step 3: Run the theme tests and verify RED**

Run: `npm run test -w packages/client -- packages/client/tests/styles/theme.test.ts`

Expected: FAIL because the new token and helper functions do not exist and base CSS still uses `normal`.

- [ ] **Step 4: Implement token application and iframe binding**

In `theme.ts`, add a module-level weak registry and the helper:

```ts
const managedThemeTokens = new WeakMap<HTMLElement, Set<string>>();

export function applyThemeTokensToElement(element: HTMLElement, tokens: ThemeTokens): void {
  const previous = managedThemeTokens.get(element) ?? new Set<string>();
  const next = new Set(Object.keys(tokens));
  for (const token of previous) {
    if (!next.has(token)) element.style.removeProperty(token);
  }
  for (const [token, value] of Object.entries(tokens)) {
    element.style.setProperty(token, value);
  }
  managedThemeTokens.set(element, next);
}
```

Add `--ce-color-scheme: dark` to both `DEFAULT_THEME_TOKENS` and `tokens.css`. Keep `renderThemeVariables` temporarily because `EditorApp` still consumes it until Task 3.

In `iframe-theme.ts`, apply tokens to `document.documentElement`, keep only the base UI style tag, change its scheme declaration, and add:

```ts
export function bindThemeToIframe(
  iframe: HTMLIFrameElement,
  getTokens: () => ThemeTokens,
): () => void {
  let active = true;
  const apply = () => {
    if (!active || !iframe.contentDocument) return;
    applyThemeToDocument(iframe.contentDocument, getTokens());
  };
  iframe.addEventListener('load', apply);
  apply();
  return () => {
    if (!active) return;
    active = false;
    iframe.removeEventListener('load', apply);
  };
}
```

- [ ] **Step 5: Run the theme tests and verify GREEN**

Run: `npm run test -w packages/client -- packages/client/tests/styles/theme.test.ts`

Expected: PASS with token cleanup and binding cleanup covered.

- [ ] **Step 6: Commit the isolated change**

```bash
git add packages/client/tests/styles/theme.test.ts packages/client/src/styles/theme.ts packages/client/src/styles/tokens.css packages/client/src/styles/iframe-theme.ts
git commit -m "[Bug] 统一 iframe 主题变量绑定"
```

---

### Task 3: Make `EditorApp` own live iframe bindings

**Files:**
- Modify: `packages/client/tests/components/editor-app.test.ts:222-243,1288-1317`
- Modify: `packages/client/src/components/editor-app.ts:1-140,240-269,594-614`

**Interfaces:**
- Consumes: `applyThemeTokensToElement` and `bindThemeToIframe` from Task 2.
- Produces: one binding cleanup entry per live iframe and no inline theme serialization.

- [ ] **Step 1: Change the iframe synchronization test to assert DOM token properties**

Replace token-style assertions with:

```ts
expect(iframeDocument.getElementById('ce-theme-tokens')).toBeNull();
expect(iframeDocument.documentElement.style.getPropertyValue('--ce-workbench-bg'))
  .toBe('var(--ce-surface)');
expect(iframeDocument.getElementById('ce-base-ui-theme')?.textContent)
  .toContain('color-scheme: var(--ce-color-scheme, dark);');
```

Add the binding cleanup test:

```ts
it('disposes iframe theme bindings when disconnected', async () => {
  el = document.createElement('editor-app') as EditorApp;
  document.body.appendChild(el);
  await waitForBootstrap();

  const panel = Array.from(el.querySelectorAll('ce-panel')).find(
    (candidate) => candidate.getAttribute('src')?.includes('%40itharbors%2Fplugin-list.list'),
  ) as HTMLElement;
  const iframe = panel.shadowRoot!.querySelector('iframe') as HTMLIFrameElement;
  const iframeDocument = document.implementation.createHTMLDocument('plugin-list');
  Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: iframeDocument });
  iframe.dispatchEvent(new Event('load'));
  expect(iframeDocument.documentElement.style.getPropertyValue('--ce-accent')).not.toBe('');

  el.remove();
  iframeDocument.documentElement.style.removeProperty('--ce-accent');
  iframe.dispatchEvent(new Event('load'));
  expect(iframeDocument.documentElement.style.getPropertyValue('--ce-accent')).toBe('');
});
```

- [ ] **Step 2: Run the editor-app test and verify RED**

Run: `npm run test -w packages/client -- packages/client/tests/components/editor-app.test.ts`

Expected: FAIL because `EditorApp` still serializes theme variables and does not own disposable bindings.

- [ ] **Step 3: Integrate the binding helpers**

Add:

```ts
private readonly iframeThemeBindings = new Map<HTMLIFrameElement, () => void>();
```

After assigning `innerHTML`, obtain the outer `ce-split-pane` and call `applyThemeTokensToElement(outer, this.hostThemeTokens)`. Remove `${renderThemeVariables(...)}` from the inline template, delete the now-unused `renderThemeVariables` function, and remove its imports.

Rewrite `syncIframeThemes()` to build a `Set` of live iframes, create bindings only for absent entries, then dispose and delete entries not in the live set. Add `clearIframeThemeBindings()` and call it from `disconnectedCallback()`.

- [ ] **Step 4: Run the focused client tests and verify GREEN**

Run:

```bash
npm run test -w packages/client -- \
  packages/client/tests/components/editor-app.test.ts \
  packages/client/tests/styles/theme.test.ts \
  packages/client/tests/layout/panel.test.ts
```

Expected: PASS with no type errors.

- [ ] **Step 5: Commit the isolated change**

```bash
git add packages/client/tests/components/editor-app.test.ts packages/client/src/components/editor-app.ts packages/client/src/styles/theme.ts
git commit -m "[Bug] 集中管理面板主题生命周期"
```

---

### Task 4: Validate Kit theme manifests on the server

**Files:**
- Create: `packages/server/src/framework/kit/theme.ts`
- Create: `packages/server/tests/framework/kit-theme.test.ts`
- Modify: `packages/server/src/editor/index.ts:221-269`

**Interfaces:**
- Produces: `normalizeKitTheme(input: unknown, kitName: string): Record<\`--ce-${string}\`, string> | undefined`.
- Consumes: raw `pkg['ce-editor'].kit.theme` JSON value.

- [ ] **Step 1: Write failing unit tests for normalization**

```ts
describe('normalizeKitTheme', () => {
  it('returns undefined for a missing theme', () => {
    expect(normalizeKitTheme(undefined, '@example/kit')).toBeUndefined();
  });

  it('returns a copied valid theme', () => {
    expect(normalizeKitTheme({ '--ce-accent': '#55aaff' }, '@example/kit'))
      .toEqual({ '--ce-accent': '#55aaff' });
  });

  it.each([
    [[], 'theme must be an object'],
    [{ accent: '#55aaff' }, 'invalid theme token "accent"'],
    [{ '--ce-accent': 42 }, 'theme token "--ce-accent" must be a string'],
  ])('rejects invalid theme input %#', (input, message) => {
    expect(() => normalizeKitTheme(input, '@example/kit')).toThrow(message);
  });
});
```

- [ ] **Step 2: Run the focused server test and verify RED**

Run: `npm run test -w packages/server -- packages/server/tests/framework/kit-theme.test.ts`

Expected: FAIL because `normalizeKitTheme` does not exist.

- [ ] **Step 3: Implement strict structural normalization**

```ts
const THEME_TOKEN_PATTERN = /^--ce-[a-z0-9-]+$/;

export function normalizeKitTheme(
  input: unknown,
  kitName: string,
): Record<`--ce-${string}`, string> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Kit "${kitName}" theme must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [token, value] of Object.entries(input)) {
    if (!THEME_TOKEN_PATTERN.test(token)) {
      throw new Error(`Kit "${kitName}" has invalid theme token "${token}"`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Kit "${kitName}" theme token "${token}" must be a string`);
    }
    normalized[token] = value;
  }
  return normalized as Record<`--ce-${string}`, string>;
}
```

Call this function when constructing `KitDescriptor` in `editor/index.ts`.

- [ ] **Step 4: Run server unit and editor framework tests**

Run:

```bash
npm run test -w packages/server -- \
  packages/server/tests/framework/kit-theme.test.ts \
  packages/server/tests/framework/editor.test.ts
```

Expected: PASS and existing valid Kits continue loading.

- [ ] **Step 5: Commit the isolated change**

```bash
git add packages/server/src/framework/kit/theme.ts packages/server/tests/framework/kit-theme.test.ts packages/server/src/editor/index.ts
git commit -m "[Bug] 校验 Kit 主题配置契约"
```

---

### Task 5: Paint Default Kit simple-panel roots with semantic surfaces

**Files:**
- Modify: `kits/default/package.json`
- Modify: `kits/default/plugins/title-bar/panel.title/src/index.css:5-20`
- Modify: `kits/default/plugins/status-bar/panel.status/src/index.css:5-20`
- Create: `kits/default/tests/panel-surfaces.test.mjs`
- Modify: root `package.json` test script

**Interfaces:**
- Consumes: injected `--ce-surface` and `--ce-border` theme tokens.
- Produces: Default Kit title/status roots always paint an opaque semantic surface.

- [ ] **Step 1: Add a failing Default Kit source-contract test**

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const relativePath of [
  'plugins/title-bar/panel.title/src/index.css',
  'plugins/status-bar/panel.status/src/index.css',
]) {
  test(`${relativePath} paints its panel root with the semantic surface`, () => {
    const css = readFileSync(path.join(kitRoot, relativePath), 'utf8');
    const rootRule = css.match(/#panel-root\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rootRule, /background:\s*var\(--ce-surface,/);
  });
}
```

Add `"test": "node --test tests/*.test.mjs"` to the Default Kit package and add `npm run test -w @itharbors/kit-default` to the root test sequence.

- [ ] **Step 2: Run the Default Kit test and verify RED**

Run: `npm run test -w @itharbors/kit-default`

Expected: two failures because neither root currently declares a background.

- [ ] **Step 3: Replace hardcoded body/root surface values in the affected panels**

For both files, use:

```css
body {
  margin: 0;
  background: var(--ce-surface, #101010);
  color: var(--ce-text-primary, #d4d4d4);
  font-size: 12px;
}

#panel-root {
  background: var(--ce-surface, #101010);
}
```

Use this exact surface declaration in both panels. Convert the title border to `var(--ce-border, #2a2a2a)`.

- [ ] **Step 4: Run Default Kit and focused client tests**

Run:

```bash
npm run test -w @itharbors/kit-default
npm run test -w packages/client -- packages/client/tests/layout/panel.test.ts packages/client/tests/styles/theme.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated change**

```bash
git add package.json kits/default/package.json kits/default/tests/panel-surfaces.test.mjs kits/default/plugins/title-bar/panel.title/src/index.css kits/default/plugins/status-bar/panel.status/src/index.css
git commit -m "[Bug] 修复默认 Kit 简单面板底色"
```

---

### Task 6: Verify the complete branch and prepare the PR

**Files:**
- Review: all files changed since `a3f2143c318b383d80930f09cd60804b31bd6aca`
- Create outside repository: a temporary PR body file with `## Summary` and `## Testing`

**Interfaces:**
- Consumes: all preceding commits.
- Produces: a clean, pushed branch and a GitHub PR created by `finish-change.sh`.

- [ ] **Step 1: Run focused regression suites**

```bash
npm run test -w packages/client -- \
  packages/client/tests/layout/panel.test.ts \
  packages/client/tests/styles/theme.test.ts \
  packages/client/tests/components/editor-app.test.ts
npm run test -w packages/server -- \
  packages/server/tests/framework/kit-theme.test.ts \
  packages/server/tests/framework/editor.test.ts
npm run test -w @itharbors/kit-default
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run full verification**

```bash
npm test
npm run build
```

Expected: both commands exit 0. If either fails, fix the failure with a new red-green cycle and rerun both commands.

- [ ] **Step 3: Inspect repository state and diff**

```bash
git status --short
git diff --check a3f2143c318b383d80930f09cd60804b31bd6aca..HEAD
git diff --stat a3f2143c318b383d80930f09cd60804b31bd6aca..HEAD
git log --oneline a3f2143c318b383d80930f09cd60804b31bd6aca..HEAD
```

Expected: clean worktree, no whitespace errors, only scoped files, and `[Bug]` commit titles.

- [ ] **Step 4: Request code review and resolve findings**

Provide the reviewer the base SHA, head SHA, design document, this plan, and the complete diff. Fix every Critical or Important finding and rerun the affected focused tests plus full verification.

- [ ] **Step 5: Create the PR through the repository workflow**

Create `/tmp/harbors-iframe-theme-pr-body.md` outside the repository containing `## Summary` and `## Testing` with the exact successful checks, then run:

```bash
/Users/bytedance/Project/harbors/.agents/skills/change-workflow/scripts/finish-change.sh \
  "修复 iframe 主题与面板表面契约" \
  /tmp/harbors-iframe-theme-pr-body.md
```

Expected: output includes a verified `PR_URL=`. Keep the worktree and branch for PR feedback.
