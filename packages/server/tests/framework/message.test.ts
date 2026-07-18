import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageModule } from '../../src/framework/message/index';
import { createEditor } from '../../src/editor/index';
import { testAssembly } from '../helpers/assembly';

describe('MessageModule', () => {
  let messageModule: MessageModule;
  const messagePluginPath = '../../../../plugins/message/main/dist/index.js';

  beforeEach(() => {
    messageModule = new MessageModule();
  });

  it('registerRequest adds a request handler', () => {
    messageModule.registerRequest('plugin', 'echo', (...args) => args, 'server');
    expect(messageModule.queryRequest('plugin', 'echo')?.location).toBe('server');
  });

  it('registerRequest throws for duplicate plugin handler', () => {
    messageModule.registerRequest('plugin', 'echo', () => undefined);
    expect(() => messageModule.registerRequest('plugin', 'echo', () => undefined)).toThrow(/already registered/);
  });

  it('request calls server handlers directly', async () => {
    messageModule.registerRequest('math', 'add', (a, b) => (a as number) + (b as number));
    await expect(messageModule.request('math', 'add', 3, 4)).resolves.toBe(7);
  });

  it('dispatches browser request methods through the injected dispatcher', async () => {
    const dispatch = vi.fn(async (panel, method, args) => ({ panel, method, args }));
    messageModule = new MessageModule({ dispatchBrowserRequest: dispatch });
    messageModule.registerRequest('browser', 'render', () => 'unused', 'browser', ['panel.render']);

    await expect(messageModule.request('browser', 'render', '@scope/view.main', { id: 1 })).resolves.toEqual({
      panel: '@scope/view.main',
      method: 'render',
      args: [{ id: 1 }],
    });
  });

  it('rejects browser routes without a dispatchable panel method', async () => {
    messageModule = new MessageModule({ dispatchBrowserRequest: vi.fn() });
    messageModule.registerRequest('browser', 'render', () => 'unused', 'browser', ['render']);

    await expect(messageModule.request('browser', 'render')).rejects.toThrow(/browser-dispatchable panel method/);
  });

  it('broadcast calls all handlers for a topic', () => {
    const calls: string[] = [];
    messageModule.registerBroadcast('p1', 'evt', () => { calls.push('p1'); });
    messageModule.registerBroadcast('p2', 'evt', () => { calls.push('p2'); });
    messageModule.broadcast('evt');
    expect(calls).toEqual(['p1', 'p2']);
  });

  it('registers request and broadcast routes independently', async () => {
    const message = new MessageModule();
    const requestHandler = vi.fn(async () => 'ok');
    const broadcastHandler = vi.fn();

    message.registerRequest('demo', 'runTest', requestHandler, 'server', ['test']);
    message.registerBroadcast('demo', '@demo/assets.changed', broadcastHandler, 'server', ['onAssetsChanged']);

    expect(await message.request('demo', 'runTest')).toBe('ok');
    message.broadcast('@demo/assets.changed', { id: 1 });
    expect(broadcastHandler).toHaveBeenCalledWith({ id: 1 });
  });

  it('routes request handlers independently from broadcast handlers', async () => {
    const message = new MessageModule();
    const requestHandler = vi.fn(async (...args) => ({ args }));
    const broadcastHandler = vi.fn();

    message.registerRequest('demo', 'runTest', requestHandler, 'server', ['test']);
    message.registerBroadcast('demo', '@demo/assets.changed', broadcastHandler, 'server', ['onAssetsChanged']);

    expect(await message.request('demo', 'runTest', 'a', 'b')).toEqual({ args: ['a', 'b'] });
    message.broadcast('@demo/assets.changed', { id: 1 });
    expect(broadcastHandler).toHaveBeenCalledWith({ id: 1 });
    expect(message.queryBroadcast('@demo/assets.changed')).toHaveLength(1);
  });

  it('passes panel key as the first argument when a request route targets panel methods', async () => {
    const panelDispatch = vi.fn(async (panelKey, method, args) => ({ panelKey, method, args }));
    const message = new MessageModule({ dispatchPanelRequest: panelDispatch });

    message.registerRequest('demo', 'runPreview', async (...args) => args, 'server', ['panel.runPreview']);

    await message.request('demo', 'runPreview', '@scope/demo.preview', { count: 1 });

    expect(panelDispatch).toHaveBeenCalledWith('@scope/demo.preview', 'runPreview', [{ count: 1 }]);
  });

  it('notifies wildcard request listeners without changing the matched result', async () => {
    const message = new MessageModule();
    const wildcardHandler = vi.fn(async () => 'ignored');
    const exactHandler = vi.fn(async (value) => `exact:${value}`);

    message.registerRequest('observer', '*', wildcardHandler, 'server', ['onAnyRequest']);
    message.registerRequest('demo', 'runTest', exactHandler, 'server', ['runTest']);

    await expect(message.request('demo', 'runTest', 'payload')).resolves.toBe('exact:payload');
    expect(wildcardHandler).toHaveBeenCalledWith({ plugin: 'demo', name: 'runTest' }, 'payload');
  });

  it('notifies wildcard broadcast listeners alongside exact topic listeners', () => {
    const message = new MessageModule();
    const exactHandler = vi.fn();
    const wildcardHandler = vi.fn();

    message.registerBroadcast('demo', '@demo.assets.changed', exactHandler, 'server', ['onAssetsChanged']);
    message.registerBroadcast('observer', '*', wildcardHandler, 'server', ['onAnyBroadcast']);

    message.broadcast('@demo.assets.changed', { id: 1 });

    expect(exactHandler).toHaveBeenCalledWith({ id: 1 });
    expect(wildcardHandler).toHaveBeenCalledWith({ topic: '@demo.assets.changed' }, { id: 1 });
  });

  it('registers request and broadcast routes from contribute.message.request and contribute.message.broadcast', async () => {
    const editor = createEditor('message-builtin-session', { assembly: testAssembly });
    const messagePlugin = await import(messagePluginPath) as {
      load(ed: unknown): void;
      attach(pluginName: string, contribute: object): void;
    };

    messagePlugin.load(editor);
    messagePlugin.attach('@scope/demo', {
      message: {
        request: {
          runTest: ['test'],
          runPreview: ['panel.runPreview'],
        },
        broadcast: {
          '@scope/demo.assets.changed': ['onAssetsChanged', 'panel.onAssetsChanged'],
        },
      },
    });

    expect(editor.message.queryRequest('@scope/demo', 'runTest')?.methods).toEqual(['test']);
    expect(editor.message.queryRequest('@scope/demo', 'runPreview')?.methods).toEqual(['panel.runPreview']);
    expect(editor.message.queryBroadcast('@scope/demo.assets.changed')[0]?.methods).toEqual([
      'onAssetsChanged',
      'panel.onAssetsChanged',
    ]);
  });

  it('registers wildcard listeners from contribute.message.request and contribute.message.broadcast', async () => {
    const editor = createEditor('message-builtin-wildcard-session', { assembly: testAssembly });
    const messagePlugin = await import(messagePluginPath) as {
      load(ed: unknown): void;
      attach(pluginName: string, contribute: object): void;
    };

    messagePlugin.load(editor);
    messagePlugin.attach('@scope/observer', {
      message: {
        request: {
          '*': ['onAnyRequest'],
        },
        broadcast: {
          '*': ['onAnyBroadcast'],
        },
      },
    });

    expect(editor.message.queryRequest('@scope/observer', '*')?.methods).toEqual(['onAnyRequest']);
    expect(editor.message.queryBroadcast('*')[0]?.methods).toEqual(['onAnyBroadcast']);
  });
});
