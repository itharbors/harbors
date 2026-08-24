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
});
