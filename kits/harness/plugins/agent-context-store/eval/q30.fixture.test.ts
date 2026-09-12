import assert from 'node:assert/strict';
import test from 'node:test';
import { loadQ30Fixture, scoreAnswer } from './q30-contract.js';

test('Q30 fixture 冻结为三类各 10 条且结构有效', async () => {
  const cases = await loadQ30Fixture();
  assert.equal(cases.length, 30);
  assert.equal(new Set(cases.map((item) => item.id)).size, 30);
  for (const category of ['single-turn', 'multi-turn-correction', 'ten-turn-delayed-recall'] as const) {
    assert.equal(cases.filter((item) => item.category === category).length, 10);
  }
  for (const item of cases) {
    assert.match(item.id, /^(S|M|D)\d{2}$/u);
    assert.ok(item.turns.length > 0);
    assert.ok(Object.keys(item.expected.state).length > 0);
    assert.ok(item.expected.anchors.length > 0);
    assert.ok(Object.keys(item.expected.forbiddenState).length > 0);
    if (item.category === 'single-turn') assert.equal(item.turns.length, 1);
    if (item.category === 'multi-turn-correction') assert.ok(item.turns.length >= 3);
    if (item.category === 'ten-turn-delayed-recall') assert.equal(item.turns.length, 10);
  }
});

test('Q30 评分归一化等价状态，并只把最终有效 state 中的旧值判为错误', () => {
  const item = { id: 'S00', category: 'single-turn' as const, turns: ['x'], expected: { state: { path: 'src/a.ts', values: ['A'], enabled: false }, anchors: ['90 秒'], forbiddenState: { path: ['src/b.ts'] } } };
  assert.deepEqual(scoreAnswer(item, { state: { path: ['src/a.ts'], values: 'A', enabled: false }, recalledAnchors: [], answer: '90秒；不修改 src/b.ts' }), { passed: true, failures: [] });
  assert.deepEqual(scoreAnswer(item, { state: { path: 'src/b.ts', values: 'A', enabled: false }, recalledAnchors: [], answer: '90 秒' }).failures, ['state_mismatch', 'forbidden_state:path:"src/b.ts"']);
});

test('Q30 评分仍拒绝缺字段、错误布尔值和缺失锚点', () => {
  const item = { id: 'S00', category: 'single-turn' as const, turns: ['x'], expected: { state: { value: 7, enabled: true }, anchors: ['ANCHOR_7'], forbiddenState: { value: [8] } } };
  assert.deepEqual(scoreAnswer(item, { state: { value: 7, enabled: true }, recalledAnchors: ['ANCHOR_7'], answer: 'ok' }), { passed: true, failures: [] });
  assert.deepEqual(scoreAnswer(item, { state: { value: 8, enabled: false }, recalledAnchors: [], answer: 'wrong' }).failures, ['state_mismatch', 'missing_anchor:ANCHOR_7', 'forbidden_state:value:8']);
});
