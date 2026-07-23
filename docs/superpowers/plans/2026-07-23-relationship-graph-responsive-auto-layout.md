# Relationship Graph Responsive Auto Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SQLite and MySQL relationship graph auto-arrange choose a readable layout shape from the current canvas width and height, including when the graph forms one business group.

**Architecture:** Keep the shared `@itharbors/relationship-graph` package as the only implementation point. Generate left-to-right and top-to-bottom group candidates from the same foreign-key ranks, score them by fitted readability and target aspect ratio, then run the existing deterministic group packing and viewport fit.

**Tech Stack:** TypeScript 5.7, Vitest, workspace package `@itharbors/relationship-graph`, existing SQLite/MySQL vanilla DOM panels.

## Global Constraints

- Do not add a graph-layout dependency or random/iterative placement.
- The same graph and canvas must produce exactly the same coordinates and paths.
- Window resize records canvas size but must not automatically replace manual or cached positions.
- Automatic viewport scale remains capped at `1` and floored at `0.3`.
- All implementation belongs in the shared relationship graph package; SQLite and MySQL panel behavior must remain identical.
- Preserve iterative SCC traversal and the 5,000-table-chain regression.

---

### Task 1: Prove single-group layout responds to the canvas

**Files:**
- Modify: `packages/relationship-graph/tests/layout.test.ts`
- Modify: `packages/relationship-graph/src/layout.ts`

**Interfaces:**
- Consumes: `layoutRelationshipGraph(graph: RelationshipGraph, requestedCanvas: CanvasSize): RelationshipLayout`
- Produces: internal `layoutGroup(key, tables, relationships, canvas): GroupBox` with deterministic horizontal and vertical candidates; no public API changes.

- [ ] **Step 1: Write the failing single-group regression test**

Add a graph whose same-prefix tables are deliberately placed in one name group and one foreign-key star, so the existing outer group packer has only one box:

```ts
it('changes a single connected group direction to use the current canvas', () => {
  const graph: RelationshipGraph = {
    tables: [
      table('account'),
      table('account_address', 2),
      table('account_audit', 3),
      table('account_profile', 4),
      table('account_role', 2),
    ],
    relationships: [
      relationship('address:account', 'account_address', 'account'),
      relationship('audit:account', 'account_audit', 'account'),
      relationship('profile:account', 'account_profile', 'account'),
      relationship('role:account', 'account_role', 'account'),
    ],
  };

  const wide = layoutRelationshipGraph(graph, { width: 1_600, height: 500 });
  const tall = layoutRelationshipGraph(graph, { width: 500, height: 1_600 });

  expectNoOverlap(wide);
  expectNoOverlap(tall);
  expect(wide.width / wide.height).toBeGreaterThan(1);
  expect(tall.width / tall.height).toBeLessThan(1);
  expect(wide).toEqual(layoutRelationshipGraph(graph, { width: 1_600, height: 500 }));
  expect(tall).toEqual(layoutRelationshipGraph(graph, { width: 500, height: 1_600 }));
});
```

- [ ] **Step 2: Run the test to verify the existing fixed group direction fails**

Run:

```bash
npm run test -w @itharbors/relationship-graph -- tests/layout.test.ts
```

Expected: FAIL because the wide single group remains taller than it is wide.

- [ ] **Step 3: Implement horizontal and vertical rank candidates**

In `packages/relationship-graph/src/layout.ts`, pass the safe canvas into `layoutGroup` and extract candidate construction:

```ts
type LayoutDirection = 'left-to-right' | 'top-to-bottom';

function layoutRankedNodes(
  key: string,
  layers: Map<number, RelationshipTable[]>,
  direction: LayoutDirection,
): RelationshipNodeLayout[] {
  const nodes: RelationshipNodeLayout[] = [];
  let rankOffset = 0;
  for (const rank of [...layers.keys()].sort((left, right) => left - right)) {
    const tables = layers.get(rank)!.slice().sort((left, right) => compareTableNames(left.name, right.name));
    let memberOffset = 0;
    let rankSpan = 0;
    for (const table of tables) {
      const height = tableHeight(table);
      nodes.push({
        name: table.name,
        group: key,
        x: direction === 'left-to-right' ? rankOffset : memberOffset,
        y: direction === 'left-to-right' ? memberOffset : rankOffset,
        width: RELATIONSHIP_LAYOUT.nodeWidth,
        height,
      });
      memberOffset += (direction === 'left-to-right' ? height : RELATIONSHIP_LAYOUT.nodeWidth)
        + RELATIONSHIP_LAYOUT.nodeGap;
      rankSpan = Math.max(
        rankSpan,
        direction === 'left-to-right' ? RELATIONSHIP_LAYOUT.nodeWidth : height,
      );
    }
    rankOffset += rankSpan + RELATIONSHIP_LAYOUT.layerGap;
  }
  return nodes;
}
```

Build the two candidates from identical layers, include isolated nodes using a canvas-derived column count, normalize their bounds to local `(0, 0)`, and choose with a stable scorer:

```ts
function fittedScale(width: number, height: number, canvas: CanvasSize): number {
  return Math.min(canvas.width / Math.max(1, width), canvas.height / Math.max(1, height), 1);
}

function groupCandidateScore(box: GroupBox, canvas: CanvasSize): [number, number, number] {
  const scale = fittedScale(box.width, box.height, canvas);
  const aspectError = Math.abs(Math.log((box.width / box.height) / (canvas.width / canvas.height)));
  return [-scale, aspectError, box.width * box.height];
}
```

Compare tuple items in order; on a full tie prefer `top-to-bottom` for `canvas.width >= canvas.height`, otherwise `left-to-right`.

- [ ] **Step 4: Run the focused test and all relationship layout tests**

Run:

```bash
npm run test -w @itharbors/relationship-graph -- tests/layout.test.ts
```

Expected: PASS; the new regression produces a wide box on `1600 × 500` and a tall box on `500 × 1600`, with no overlap.

- [ ] **Step 5: Commit the group candidate behavior**

```bash
git add packages/relationship-graph/src/layout.ts packages/relationship-graph/tests/layout.test.ts
git commit -m '[Optimize] 自适应关系图组内布局方向'
```

### Task 2: Optimize final packing for readable fitted scale

**Files:**
- Modify: `packages/relationship-graph/src/layout.ts`
- Modify: `packages/relationship-graph/tests/layout.test.ts`

**Interfaces:**
- Consumes: internal `packGroups(groups: GroupBox[], columns: number): PackedGroups`
- Produces: internal deterministic packing comparison that prioritizes the fitted node scale, then aspect error, empty ratio, cross-group edge span, and fewer columns.

- [ ] **Step 1: Add a regression that compares candidate readability**

Add helpers that calculate node bounds and uncapped fit scale in the test, then assert responsive packing is not worse than forcing every business group into one column on a wide canvas:

```ts
it('uses the canvas for readable multi-group packing without shrinking cards unnecessarily', () => {
  const canvas = { width: 1_600, height: 600 };
  const layout = layoutRelationshipGraph(businessGraph, canvas);
  const bounds = layoutBounds(layout);
  const scale = Math.min(canvas.width / bounds.width, canvas.height / bounds.height, 1);

  expect(scale).toBeGreaterThanOrEqual(0.6);
  expect(layout.width / layout.height).toBeGreaterThan(1);
  expectNoOverlap(layout);
});
```

The `0.6` floor is a regression guard for the fixed fixture, not a global product threshold.

- [ ] **Step 2: Run the focused test before changing packing score**

Run:

```bash
npm run test -w @itharbors/relationship-graph -- tests/layout.test.ts
```

Expected: FAIL because the existing aspect-first weighted scorer selects a packing whose fitted scale is below `0.6` for the fixed fixture.

- [ ] **Step 3: Change packing comparison from one weighted number to stable criteria**

Replace the weighted `packingScore` result with explicit metrics:

```ts
type PackingMetrics = {
  fitScale: number;
  aspectError: number;
  emptyRatio: number;
  crossSpan: number;
};

function comparePacking(
  left: { packed: PackedGroups; metrics: PackingMetrics; columns: number },
  right: { packed: PackedGroups; metrics: PackingMetrics; columns: number },
): number {
  return compareDescending(left.metrics.fitScale, right.metrics.fitScale)
    || compareAscending(left.metrics.aspectError, right.metrics.aspectError)
    || compareAscending(left.metrics.emptyRatio, right.metrics.emptyRatio)
    || compareAscending(left.metrics.crossSpan, right.metrics.crossSpan)
    || left.columns - right.columns;
}
```

Use an epsilon of `1e-9` in numeric comparison helpers so floating-point noise cannot change the selected candidate.

- [ ] **Step 4: Run layout, session, and shared package tests**

Run:

```bash
npm run test -w @itharbors/relationship-graph
npm run build -w @itharbors/relationship-graph
```

Expected: all tests PASS and TypeScript emits the package without diagnostics.

- [ ] **Step 5: Commit the final packing criteria**

```bash
git add packages/relationship-graph/src/layout.ts packages/relationship-graph/tests/layout.test.ts
git commit -m '[Optimize] 提升关系图自动布局可读性'
```

### Task 3: Verify SQLite and MySQL integration

**Files:**
- Verify: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.ts`
- Verify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts`
- Verify: `kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts`
- Verify: `kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`
- Modify only if a regression is exposed: the corresponding test or panel file above.

**Interfaces:**
- Consumes: `RelationshipGraphSession.autoArrange(canvas: CanvasSize): void`
- Produces: verified identical SQLite/MySQL behavior with current canvas measurements; no new public interface.

- [ ] **Step 1: Run both relationship Panel suites**

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-relationships/tests/panel.test.ts
npm run test -w @itharbors/kit-mysql -- --run plugins/mysql-relationships/tests/panel.test.ts
```

Expected: PASS; existing tests show “自动排列” changes positions using mocked canvas dimensions, while “适应窗口” leaves positions intact.

- [ ] **Step 2: Run workspace type/build checks for the affected packages**

```bash
npm run build -w @itharbors/relationship-graph
npm run build -w @itharbors/kit-sqlite
npm run build -w @itharbors/kit-mysql
```

Expected: all three commands exit 0 without TypeScript diagnostics.

- [ ] **Step 3: Run repository verification**

```bash
npm run check
```

Expected: build, all repository tests, plugin checks, and change-workflow tests exit 0.

- [ ] **Step 4: Inspect the final change set**

```bash
git status --short
git diff HEAD~2 --check
git diff HEAD~2 --stat
```

Expected: only the responsive-layout spec, plan, shared layout implementation, and focused tests are changed; no whitespace errors or generated artifacts are present.

- [ ] **Step 5: Commit any verification-only correction if one was required**

If Step 1-3 exposed an integration regression and a focused correction was made:

```bash
git add kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.ts \
  kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts \
  kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts \
  kits/mysql/plugins/mysql-relationships/tests/panel.test.ts
git commit -m '[Bug] 修复关系图自适应布局回归'
```

If no correction was required, do not create an empty commit.
