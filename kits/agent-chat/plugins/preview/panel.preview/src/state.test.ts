import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activatePreviewTab,
  closePreviewTab,
  createPreviewState,
  getPreviewSession,
  openPreviewTab,
  previewKey,
  previewSessionKey,
  resolvePreviewTab,
  selectPreviewSession,
  type PreviewTab,
} from './state.ts';

function tab(id: string, key: string, requestId?: number): PreviewTab {
  return {
    id,
    key,
    href: key,
    originalHref: key,
    title: id,
    ...(requestId === undefined ? {} : { requestId }),
    content: { kind: 'file', path: key },
  };
}

test('keeps tabs and active tab independently for each conversation', () => {
  let state = createPreviewState();
  state = selectPreviewSession(state, 'conversation:a');
  state = openPreviewTab(state, 'conversation:a', tab('a-1', 'file:file:///a')).state;
  state = openPreviewTab(state, 'conversation:a', tab('a-2', 'file:file:///b')).state;
  state = selectPreviewSession(state, 'conversation:b');
  assert.deepEqual(getPreviewSession(state), { tabs: [], activeId: null });
  state = openPreviewTab(state, 'conversation:b', tab('b-1', 'https:https://example.test')).state;
  state = selectPreviewSession(state, 'conversation:a');
  assert.deepEqual(getPreviewSession(state).tabs.map((item) => item.id), ['a-1', 'a-2']);
  assert.equal(getPreviewSession(state).activeId, 'a-2');
});

test('activates an existing URI instead of duplicating it', () => {
  let state = createPreviewState();
  state = openPreviewTab(state, 'conversation:a', tab('one', 'file:file:///a')).state;
  const result = openPreviewTab(state, 'conversation:a', tab('new', 'file:file:///a'));
  assert.equal(result.created, false);
  assert.equal(result.tab.id, 'one');
  assert.deepEqual(getPreviewSession(result.state, 'conversation:a').tabs.map((item) => item.id), ['one']);
  assert.equal(getPreviewSession(result.state, 'conversation:a').activeId, 'one');
});

test('opening a tab for a background conversation does not change the selected session', () => {
  let state = createPreviewState('conversation:selected');
  state = openPreviewTab(state, 'conversation:background', tab('background', 'file:file:///background')).state;
  assert.equal(state.selectedSessionKey, 'conversation:selected');
  assert.equal(getPreviewSession(state, 'conversation:background').activeId, 'background');
});

test('closing the active tab selects the previous tab, then the next tab', () => {
  let state = createPreviewState();
  state = openPreviewTab(state, 'conversation:a', tab('one', 'one')).state;
  state = openPreviewTab(state, 'conversation:a', tab('two', 'two')).state;
  state = openPreviewTab(state, 'conversation:a', tab('three', 'three')).state;
  state = activatePreviewTab(state, 'conversation:a', 'two');
  state = closePreviewTab(state, 'conversation:a', 'two');
  assert.equal(getPreviewSession(state).activeId, 'one');
  state = closePreviewTab(state, 'conversation:a', 'one');
  assert.equal(getPreviewSession(state).activeId, 'three');
  state = closePreviewTab(state, 'conversation:a', 'three');
  assert.deepEqual(getPreviewSession(state), { tabs: [], activeId: null });
});

test('ignores late results from a closed tab or an older request', () => {
  let state = createPreviewState();
  state = openPreviewTab(state, 'conversation:a', tab('one', 'one', 1)).state;
  state = closePreviewTab(state, 'conversation:a', 'one');
  const closed = resolvePreviewTab(state, 'conversation:a', 'one', 1, { kind: 'file', content: 'late' });
  assert.deepEqual(getPreviewSession(closed), { tabs: [], activeId: null });

  state = openPreviewTab(closed, 'conversation:a', tab('new', 'one', 2)).state;
  const stale = resolvePreviewTab(state, 'conversation:a', 'new', 1, { kind: 'file', content: 'stale' });
  assert.equal(getPreviewSession(stale, 'conversation:a').tabs[0]?.content.content, undefined);
  const current = resolvePreviewTab(stale, 'conversation:a', 'new', 2, { kind: 'file', content: 'current' });
  assert.equal(getPreviewSession(current, 'conversation:a').tabs[0]?.content.content, 'current');
});

test('dedupe keys normalize file search/hash but preserve web search/hash', () => {
  assert.equal(
    previewKey('file', 'file:///tmp/%E4%B8%AD%E6%96%87.md?raw=1#L2'),
    previewKey('file', 'file:///tmp/%E4%B8%AD%E6%96%87.md'),
  );
  assert.notEqual(
    previewKey('https', 'https://example.test/a#one'),
    previewKey('https', 'https://example.test/a#two'),
  );
});

test('uses stable selection keys for conversations, drafts, and empty selection', () => {
  assert.equal(previewSessionKey({ selectedConversationId: 'conversation-a' }), 'conversation:conversation-a');
  assert.equal(previewSessionKey({ selectedConversationId: null, draft: { project: '/tmp/project-a' } }), 'draft:/tmp/project-a');
  assert.equal(previewSessionKey({ selectedConversationId: null, draft: null }), 'empty');
});
