# Relationship Graph Focus and Curved Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make relationship graphs translucent at rest, focus a selected table and its direct neighbors, and render all relationships as smooth cubic curves.

**Architecture:** Keep graph focus semantics and edge routing in the shared `@itharbors/relationship-graph` package. SQLite and MySQL own the selected table name across DOM rerenders and supply it to the shared renderer; their CSS maps the same semantic data attributes onto each existing theme.

**Tech Stack:** TypeScript, DOM/SVG, CSS, Vitest/jsdom, existing Harbors plugin build tooling.

## Global Constraints

- Single click and Space select; double-click and Enter open table structure.
- Clicking blank canvas clears selection; completing a pan or node drag does not.
- Only the selected table, its direct incoming/outgoing neighbors, and incident relationships receive full emphasis.
- Search dimming and graph focus remain independent and compose through separate data attributes.
- Every non-self edge is a cubic Bézier; self and parallel relationships remain distinct and deterministic.
- Preserve SQLite and MySQL themes, keyboard focus, drag behavior, activity locks, and reduced-motion handling.
- Continue in `optimize/database-relationship-graph-layout`; every commit uses `[Optimize]`.

---

### Task 1: Cubic relationship routing

**Files:**
- Modify: `packages/relationship-graph/tests/layout.test.ts`
- Modify: `packages/relationship-graph/src/edges.ts`

**Interfaces:**
- Consumes: `routeRelationshipEdges(relationships, nodes)` and existing `RelationshipEdgeLayout.path`.
- Produces: deterministic SVG cubic paths whose bounds include endpoints and control points.

- [x] **Step 1: Strengthen the routing test before implementation**

In the cycle/self/parallel test, require every path to use `C`, require no non-self path to use `L`, and add a same-column graph whose edge also uses a cubic path:

```ts
for (const edge of layout.edges) {
  expect(edge.path).toContain(' C ');
  if (edge.fromTable !== edge.toTable) expect(edge.path).not.toContain(' L ');
}
const sameColumn = rebuildRelationshipLayout(graph, [
  { name: 'team', x: 0, y: 0, width: 220, height: 80, group: 'team' },
  { name: 'team_member', x: 0, y: 240, width: 220, height: 80, group: 'team' },
]);
expect(sameColumn.edges[0].path).toContain(' C ');
```

- [x] **Step 2: Run the focused test and observe the orthogonal-route failure**

Run: `npm test -w @itharbors/relationship-graph -- --run tests/layout.test.ts`

Expected: FAIL because non-self edges contain `L` commands.

- [x] **Step 3: Replace orthogonal segments with cubic control points**

For horizontal relationships, derive the nearest side endpoints and a bounded tangent:

```ts
const distance = Math.abs(toX - fromX);
const tangent = Math.max(48, Math.min(180, distance * 0.45));
const direction = targetIsRight ? 1 : -1;
const control1 = { x: fromX + direction * tangent, y: fromY + offset };
const control2 = { x: toX - direction * tangent, y: toY + offset };
points = [{ x: fromX, y: fromY }, control1, control2, { x: toX, y: toY }];
path = cubicPath(points);
```

For same-column relationships, keep the right-side lane and use it as both control-point x values:

```ts
points = [
  { x: from.x + from.width, y: fromY },
  { x: lane, y: fromY },
  { x: lane, y: toY },
  { x: to.x + to.width, y: toY },
];
path = cubicPath(points);
```

Replace `polylinePath` with:

```ts
function cubicPath(points: Array<{ x: number; y: number }>): string {
  return `M ${points[0].x} ${points[0].y} C ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;
}
```

- [x] **Step 4: Run layout tests**

Run: `npm test -w @itharbors/relationship-graph -- --run tests/layout.test.ts`

Expected: all layout tests PASS, including the 5,000-table chain.

- [x] **Step 5: Commit cubic routing**

```bash
git add packages/relationship-graph/src/edges.ts packages/relationship-graph/tests/layout.test.ts
git commit -m '[Optimize] 使用曲线绘制表关系'
```

### Task 2: Shared persistent focus interaction

**Files:**
- Modify: `packages/relationship-graph/src/render.ts`
- Modify: `packages/relationship-graph/tests/render.test.ts`

**Interfaces:**
- Consumes: `selectedTable: string | null` supplied by a database Panel.
- Produces: `onSelectTable(name: string | null)`, `data-focus`, and `aria-pressed` states.

- [x] **Step 1: Add failing renderer focus tests**

Extend the render helper defaults with `selectedTable` and `onSelectTable`, then test:

```ts
const onSelectTable = vi.fn();
const view = render({ selectedTable: 'children', onSelectTable });
expect(table(view, 'children')).toHaveAttribute('data-focus', 'selected');
expect(table(view, 'parents')).toHaveAttribute('data-focus', 'related');
expect(table(view, 'isolated')).toHaveAttribute('data-focus', 'muted');
expect(table(view, 'children')).toHaveAttribute('aria-pressed', 'true');
expect(view.querySelector('[data-relationship-edge="children:0"]'))
  .toHaveAttribute('data-focus', 'related');
```

Add interaction assertions:

```ts
table(view, 'children').click();
expect(onSelectTable).toHaveBeenCalledWith('children');
table(view, 'children').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
expect(onOpenTable).toHaveBeenCalledWith('children');
table(view, 'children').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
expect(onSelectTable).toHaveBeenCalledWith('children');
canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
expect(onSelectTable).toHaveBeenCalledWith(null);
```

Retain the existing Enter-open test and change the old single-click expectation to selection.

- [x] **Step 2: Run renderer tests and observe the missing contract**

Run: `npm test -w @itharbors/relationship-graph -- --run tests/render.test.ts`

Expected: TypeScript/runtime assertions FAIL because selection options and focus attributes do not exist.

- [x] **Step 3: Compute one-hop focus state in the renderer**

Add options:

```ts
selectedTable: string | null;
onSelectTable(name: string | null): void;
```

Build a direct-neighbor set only when the selected table exists in `tableByName`:

```ts
const selectedTable = tableByName.has(options.selectedTable ?? '') ? options.selectedTable : null;
const relatedTables = new Set<string>();
if (selectedTable !== null) {
  for (const relationship of options.graph.relationships) {
    if (relationship.fromTable === selectedTable) relatedTables.add(relationship.toTable);
    if (relationship.toTable === selectedTable) relatedTables.add(relationship.fromTable);
  }
}
```

Use `selected`, `related`, `muted`, or `idle` for cards. Mark an edge/detail `related` only when it is incident to the selection; otherwise `muted` or `idle`. Keep `data-dimmed` search logic unchanged.

- [x] **Step 4: Rewire card and canvas input semantics**

Within `installTableInteraction`:

```ts
card.addEventListener('click', (event) => {
  event.stopPropagation();
  if (suppressClick) { suppressClick = false; return; }
  options.onSelectTable(tableName);
});
card.addEventListener('dblclick', (event) => {
  event.stopPropagation();
  options.onOpenTable(tableName);
});
```

Enter calls `onOpenTable`; Space calls `onSelectTable`. Add `aria-pressed`. Extend canvas pointer state with a `moved` threshold so its click handler clears only after a true blank click, not after panning.

- [x] **Step 5: Run renderer and shared package tests**

Run:

```bash
npm test -w @itharbors/relationship-graph -- --run tests/render.test.ts
npm test -w @itharbors/relationship-graph
```

Expected:  all shared tests PASS; drag still previews and commits once without selecting.

- [x] **Step 6: Commit focus semantics**

```bash
git add packages/relationship-graph/src/render.ts packages/relationship-graph/tests/render.test.ts
git commit -m '[Optimize] 支持聚焦查看一跳表关系'
```

### Task 3: SQLite and MySQL focus state and visual hierarchy

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.css`
- Modify: `kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.css`
- Modify: `kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`

**Interfaces:**
- Consumes: shared renderer `selectedTable` and `onSelectTable`.
- Produces: database-scoped selection lifecycle and theme-specific opacity/border styles.

- [ ] **Step 1: Add failing SQLite and MySQL Panel tests**

For both Panels, select `users`, force a normal rerender through zoom, and verify persistence:

```ts
table('users').click();
expect(table('users').dataset.focus).toBe('selected');
expect(table('user_profiles').dataset.focus).toBe('related');
expect(table('orders').dataset.focus).toBe('muted');
button('+').click();
expect(table('users').dataset.focus).toBe('selected');
```

Then send a Schema graph without `users` and verify no table remains selected. Send a connection change and verify selection resets. In MySQL, begin a pending open/load activity and assert table click does not change `data-focus`.

- [ ] **Step 2: Run Panel tests and observe selection loss**

Run:

```bash
npx vitest run --config vitest.config.ts plugins/sqlite-relationships/tests/panel.test.ts
npx vitest run --config vitest.config.ts plugins/mysql-relationships/tests/panel.test.ts
```

Run each command from its Kit directory. Expected: FAIL because Panels do not own selected state or pass the new renderer contract.

- [ ] **Step 3: Add Panel-owned selection state**

In both Panel modules add:

```ts
let selectedTable: string | null = null;
```

Clear it in `clearState` and `onConnectionChanged`. After every successful graph load/update:

```ts
if (!next.tables.some((table) => table.name === selectedTable)) selectedTable = null;
```

Pass it to the renderer and rerender on selection:

```ts
selectedTable,
onSelectTable: (name) => {
  if (activity === null) {
    selectedTable = name;
    render();
  }
},
```

SQLite omits the activity guard because it has no activity overlay.

- [ ] **Step 4: Apply restrained theme-specific focus CSS**

In both themes, use the same hierarchy with existing variables:

```css
.relationship-table { opacity: .58; }
.relationship-table[data-focus="selected"],
.relationship-table[data-focus="related"],
.relationship-table:hover,
.relationship-table:focus-visible { opacity: 1; }
.relationship-table[data-focus="selected"] { border-width: 2px; }
.relationship-edges path { opacity: .3; stroke-linecap: round; }
.relationship-edges path[data-focus="related"] { opacity: 1; stroke-width: 2; }
.relationship-edges path[data-focus="muted"] { opacity: .1; }
```

Give SQLite selected cards `border-color: var(--teal)` and MySQL selected cards
`border-color: var(--cyan)`. Related cards use the existing hover color. Keep
`[data-dimmed="true"]` at the strongest low-opacity level and retain reduced-motion rules.

- [ ] **Step 5: Run both Panel suites and plugin checks**

Run:

```bash
npm run build -w @itharbors/relationship-graph
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-relationships
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-relationships
node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-relationships
node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-relationships
npm run test -w @itharbors/kit-sqlite
npm run test -w @itharbors/kit-mysql
```

Expected: plugin builds/checks and both Kit suites PASS; MySQL's environment-guarded integration test may remain skipped.

- [ ] **Step 6: Commit Panel integration**

```bash
git add kits/sqlite/plugins/sqlite-relationships kits/mysql/plugins/mysql-relationships
git commit -m '[Optimize] 强化表关系选中视觉层级'
```

### Task 4: Final verification and PR update

**Files:**
- Modify only if verification exposes a focus/curve defect.

**Interfaces:**
- Verifies the complete follow-up against the existing PR.
- Produces a clean pushed branch with PR #14 updated.

- [ ] **Step 1: Run fresh full verification**

Run:

```bash
npm run build
npm test
npm run plugins:check
git diff --check origin/main..HEAD
git status --short
```

Expected: all commands PASS, only the existing guarded MySQL runtime test is skipped, and the worktree is clean.

- [ ] **Step 2: Inspect focus and curve ownership**

Run:

```bash
rg -n "selectedTable|data-focus|cubicPath" packages/relationship-graph kits/sqlite/plugins/sqlite-relationships kits/mysql/plugins/mysql-relationships
gh pr view 14 --json state,headRefName,url
```

Expected: routing/focus semantics live in the shared package, theme/state integration lives in each Panel, and PR #14 is OPEN on `optimize/database-relationship-graph-layout`.

- [ ] **Step 3: Push the existing branch**

Run: `git push`

Expected: GitHub reports the branch update and PR #14 includes all follow-up commits.
