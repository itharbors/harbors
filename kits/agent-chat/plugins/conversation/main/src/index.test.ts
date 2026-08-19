import assert from 'node:assert/strict';
import test from 'node:test';

let plugin: any;
(globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
await import('./index.ts?conversation-selected-project');

test('选择已有会话时状态快照和广播携带对应项目目录', async () => {
  const broadcasts: Array<[string, unknown]> = [];
  const conversations = [
    { id: 'conversation-a', title: 'A', project: '/workspace/a' },
    { id: 'conversation-b', title: 'B', project: '/workspace/b' },
  ];
  const runtime = {
    message: {
      broadcast(topic: string, value: unknown) {
        broadcasts.push([topic, value]);
      },
      request(_target: string, method: string) {
        assert.equal(method, 'listConversations');
        return Promise.resolve(conversations);
      },
    },
  };

  plugin.lifecycle.load(runtime);
  try {
    const snapshot = await plugin.methods.select('conversation-b');
    assert.equal(snapshot.selectedConversationId, 'conversation-b');
    assert.equal(snapshot.selectedProject, '/workspace/b');

    const selectedBroadcasts = broadcasts.filter(([topic]) => topic === 'conversation.selected');
    assert.ok(selectedBroadcasts.length > 0);
    const broadcastSnapshot: any = selectedBroadcasts.at(-1)?.[1];
    assert.equal(broadcastSnapshot.selectedConversationId, 'conversation-b');
    assert.equal(broadcastSnapshot.selectedProject, '/workspace/b');
  } finally {
    plugin.lifecycle.unload();
  }
});

test('草稿和空选择不伪造 selectedProject', async () => {
  const broadcasts: Array<[string, unknown]> = [];
  const runtime = {
    message: {
      broadcast(topic: string, value: unknown) {
        broadcasts.push([topic, value]);
      },
      request() {
        return Promise.resolve([]);
      },
    },
  };

  plugin.lifecycle.load(runtime);
  try {
    const draftSnapshot = await plugin.methods.select(null, { project: '/workspace/draft' });
    assert.equal(draftSnapshot.selectedConversationId, null);
    assert.equal(draftSnapshot.draft.project, '/workspace/draft');
    assert.equal('selectedProject' in draftSnapshot, false);

    const emptySnapshot = await plugin.methods.select(null);
    assert.equal(emptySnapshot.selectedConversationId, null);
    assert.equal('selectedProject' in emptySnapshot, false);

    const selectedBroadcasts = broadcasts.filter(([topic]) => topic === 'conversation.selected');
    assert.equal('selectedProject' in (selectedBroadcasts.at(-1)?.[1] as object), false);
  } finally {
    plugin.lifecycle.unload();
  }
});
