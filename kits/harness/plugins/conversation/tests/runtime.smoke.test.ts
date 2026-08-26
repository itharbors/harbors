import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginRuntimeHarness, type PluginRuntimeHarness } from '@itharbors/server/testing';

const pluginPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnesses: PluginRuntimeHarness[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
});

describe('Conversation Plugin runtime smoke', () => {
  it('loads the real Plugin, requests external conversations, and reacts to an external broadcast', async () => {
    const conversations = [{ id: 'conversation-a', project: '/workspace/a', title: 'A', active: false }];
    let harness!: PluginRuntimeHarness;
    harness = createPluginRuntimeHarness({
      pluginPath,
      externalRequests: [{
        plugin: 'agent',
        name: 'listConversations',
        handler: () => conversations,
      }],
      externalBroadcasts: [{
        plugin: 'agent',
        topic: 'agent.conversation.changed',
        handler: (payload) => harness.plugin.call('onConversationChanged', payload),
      }],
    });
    harnesses.push(harness);

    await harness.plugin.load();
    await expect(harness.observer.waitFor((event) => event.kind === 'request'
      && event.plugin === 'agent' && event.name === 'listConversations')).resolves.toBeDefined();

    expect(harness.plugin.isLoaded()).toBe(true);
    expect(harness.plugin.info()?.name).toBe('conversation');
    expect(harness.plugin.call('getState')).toMatchObject({
      selectedConversationId: 'conversation-a',
      draft: null,
    });

    harness.messages.broadcast('agent.conversation.changed', {
      action: 'update',
      id: 'conversation-a',
      conversation: { ...conversations[0], active: true },
    });
    expect(harness.plugin.call('getState')).toMatchObject({
      selectedConversationId: 'conversation-a',
      running: true,
    });
    expect(harness.observer.events.some((event) => event.kind === 'broadcast'
      && event.topic === 'conversation.selected')).toBe(true);
  });

  it('routes archive through Agent with Conversation caller and settles selection before resolving', async () => {
    const conversations = [{ id: 'harbors:a', project: '/workspace/a', title: 'A' }, { id: 'harbors:b', project: '/workspace/b', title: 'B' }];
    const archived = { id: 'harbors:a', source: 'harbors', title: 'A', project: '/workspace/a', archivedAt: new Date(0).toISOString(), status: 'available' };
    let harness!: PluginRuntimeHarness;
    harness = createPluginRuntimeHarness({
      pluginPath,
      externalRequests: [
        { plugin: 'agent', name: 'listConversations', handler: () => conversations },
        { plugin: 'agent', name: 'archiveConversation', handler: (id) => {
          if (id === 'harbors:b') return { ok: false, error: { code: 'CONVERSATION_ACTIVE', message: 'unsafe raw detail' } };
          expect(id).toBe('harbors:a');
          harness.messages.broadcast('agent.conversation.changed', { action: 'archive', id, archived });
          return { ok: true, value: archived };
        } },
      ],
      externalBroadcasts: [{ plugin: 'agent', topic: 'agent.conversation.changed', handler: (payload) => harness.plugin.call('onConversationChanged', payload) }],
    });
    harnesses.push(harness);
    await harness.plugin.load();
    await harness.observer.waitFor((event) => event.kind === 'request' && event.plugin === 'agent' && event.name === 'listConversations');

    const result = await harness.plugin.call('archiveConversation', 'harbors:a');
    expect(result).toEqual({ ok: true, value: archived });
    expect(harness.plugin.call('getState')).toMatchObject({ selectedConversationId: 'harbors:b' });
    const request = harness.observer.events.find((event) => event.kind === 'request' && event.plugin === 'agent' && event.name === 'archiveConversation');
    expect(request).toMatchObject({ caller: 'conversation' });
    const selected = harness.observer.events.filter((event) => event.kind === 'broadcast' && event.topic === 'conversation.selected').at(-1)!;
    expect(request!.sequence).toBeLessThan(selected.sequence);
    const selectedCount = harness.observer.events.filter((event) => event.kind === 'broadcast' && event.topic === 'conversation.selected').length;
    await expect(harness.plugin.call('archiveConversation', 'harbors:b')).resolves.toEqual({ ok: false, error: { code: 'CONVERSATION_ACTIVE', message: '对话仍在运行，请先停止后再归档' } });
    expect(harness.plugin.call('getState')).toMatchObject({ selectedConversationId: 'harbors:b' });
    expect(harness.observer.events.filter((event) => event.kind === 'broadcast' && event.topic === 'conversation.selected')).toHaveLength(selectedCount);
  });
});
