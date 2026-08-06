import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_PROCESS_PROTOCOL,
  assertPluginProcessPayload,
  parsePluginProcessEnvelope,
} from '../../src/application/plugin-process/protocol';
import { createPluginProcessRpcPeer } from '../../src/application/plugin-process/rpc-peer';

describe('plugin process protocol', () => {
  it('accepts a request for the current generation', () => {
    const request = {
      protocol: 1,
      generation: 'gen-1',
      kind: 'request' as const,
      requestId: '1',
      method: 'invoke',
      payload: { method: 'ping', args: [] },
    };

    expect(PLUGIN_PROCESS_PROTOCOL).toBe(1);
    expect(parsePluginProcessEnvelope(request, 'gen-1')).toEqual(request);
  });

  it.each([
    ['a wrong protocol', { protocol: 2, generation: 'gen-1', kind: 'event', event: 'ready', payload: null }],
    ['an unknown field', { protocol: 1, generation: 'gen-1', kind: 'event', event: 'ready', payload: null, extra: true }],
    ['a stale generation', { protocol: 1, generation: 'gen-0', kind: 'event', event: 'ready', payload: null }],
  ])('rejects %s', (_reason, envelope) => {
    expect(() => parsePluginProcessEnvelope(envelope, 'gen-1')).toThrow();
  });

  it.each([
    ['a function', { value: () => undefined }],
    ['a symbol', { value: Symbol('value') }],
    ['a custom prototype', { value: new (class Payload {})() }],
  ])('rejects payloads containing %s', (_reason, payload) => {
    expect(() => assertPluginProcessPayload(payload)).toThrow();
  });

  it('accepts null-prototype payload objects', () => {
    const payload = Object.assign(Object.create(null), { value: ['safe'] });

    expect(assertPluginProcessPayload(payload)).toEqual(payload);
  });

  it('accepts a shared-reference payload that is not cyclic', () => {
    const shared = { value: 'safe' };
    const payload = { first: shared, second: shared };

    expect(assertPluginProcessPayload(payload)).toBe(payload);
  });

  it('rejects a cyclic payload', () => {
    const payload: { self?: unknown } = {};
    payload.self = payload;

    expect(() => assertPluginProcessPayload(payload)).toThrow();
  });

  it('rejects a payload at depth 33', () => {
    let payload: unknown = 'leaf';
    for (let index = 0; index < 33; index += 1) {
      payload = { value: payload };
    }

    expect(() => assertPluginProcessPayload(payload)).toThrow();
  });

  it('rejects hostile proxies without invoking their traps', () => {
    let trapCount = 0;
    const hostile = new Proxy({ value: 'unsafe' }, {
      get() { trapCount += 1; throw new Error('get trap'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('descriptor trap'); },
      getPrototypeOf() { trapCount += 1; throw new Error('prototype trap'); },
      ownKeys() { trapCount += 1; throw new Error('keys trap'); },
    });

    expect(() => assertPluginProcessPayload({ nested: hostile })).toThrow(/proxy/i);
    expect(() => parsePluginProcessEnvelope(hostile, 'gen-1')).toThrow(/proxy/i);
    expect(trapCount).toBe(0);
  });

  it('accepts a payload at depth 32', () => {
    let payload: unknown = 'leaf';
    for (let index = 0; index < 32; index += 1) {
      payload = { value: payload };
    }

    expect(assertPluginProcessPayload(payload)).toEqual(payload);
  });

  it.each([
    ['an Array subclass', new (class Payload extends Array<unknown> {})('safe')],
    ['an array with a replaced prototype', Object.setPrototypeOf(['safe'], {} as object)],
    ['an array hole', new Array(1)],
    ['a non-enumerable numeric array property', (() => {
      const payload: string[] = [];
      Object.defineProperty(payload, '0', { value: 'safe', enumerable: false });
      return payload;
    })()],
  ])('rejects %s', (_reason, payload) => {
    expect(() => assertPluginProcessPayload(payload)).toThrow();
  });

  it('rejects an array accessor without invoking it', () => {
    let getterCalled = false;
    const payload: string[] = [];
    Object.defineProperty(payload, '0', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'unsafe';
      },
    });

    expect(() => assertPluginProcessPayload(payload)).toThrow();
    expect(getterCalled).toBe(false);
  });

  it('rejects a serialized payload larger than 1 MiB', () => {
    const payload = 'a'.repeat(1024 * 1024);

    expect(() => assertPluginProcessPayload(payload)).toThrow();
  });

  it('accepts a serialized payload exactly 1 MiB', () => {
    const payload = 'a'.repeat((1024 * 1024) - 2);

    expect(assertPluginProcessPayload(payload)).toBe(payload);
  });
});

describe('plugin process RPC peer', () => {
  it('settles a request from a matching response', async () => {
    let receive: (input: unknown) => void = () => undefined;
    const send = vi.fn();
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send,
      subscribe: (listener: (input: unknown) => void) => {
        receive = listener;
        return () => undefined;
      },
    });

    const pending = peer.request('invoke', { method: 'ping', args: [] });
    receive({ protocol: 1, generation: 'gen-1', kind: 'response', requestId: '1', ok: true, payload: 'pong' });

    await expect(pending).resolves.toBe('pong');
    expect(send).toHaveBeenCalledWith({
      protocol: 1,
      generation: 'gen-1',
      kind: 'request',
      requestId: '1',
      method: 'invoke',
      payload: { method: 'ping', args: [] },
    });
  });

  it('sends response and event envelopes for the current generation', () => {
    const send = vi.fn();
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send,
      subscribe: () => () => undefined,
    });

    peer.respond('7', { ok: true, payload: { ready: true } });
    peer.emit('ready', { capabilities: ['invoke'] });

    expect(send).toHaveBeenNthCalledWith(1, {
      protocol: 1,
      generation: 'gen-1',
      kind: 'response',
      requestId: '7',
      ok: true,
      payload: { ready: true },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      protocol: 1,
      generation: 'gen-1',
      kind: 'event',
      event: 'ready',
      payload: { capabilities: ['invoke'] },
    });
  });

  it('does not emit events or responses after close', () => {
    const send = vi.fn();
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send,
      subscribe: () => () => undefined,
    });

    peer.close(new Error('closed'));
    peer.emit('unloaded', null);
    peer.respond('late', { ok: true, payload: null });

    expect(send).not.toHaveBeenCalled();
  });

  it('normalizes a remote error without accepting a remote stack', async () => {
    let receive: (input: unknown) => void = () => undefined;
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: (listener: (input: unknown) => void) => {
        receive = listener;
        return () => undefined;
      },
    });
    const pending = peer.request('invoke', null);

    receive({
      protocol: 1,
      generation: 'gen-1',
      kind: 'response',
      requestId: '1',
      ok: false,
      error: { code: 'APPLICATION_PLUGIN_UNAVAILABLE', message: 'Plugin exited', retryable: true, retryAfterMs: 50 },
    });

    await expect(pending).rejects.toMatchObject({
      code: 'APPLICATION_PLUGIN_UNAVAILABLE',
      message: 'Plugin exited',
      retryable: true,
      retryAfterMs: 50,
    });
  });

  it('does not settle a request from malformed failure responses', async () => {
    let receive: (input: unknown) => void = () => undefined;
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: (listener: (input: unknown) => void) => {
        receive = listener;
        return () => undefined;
      },
    });
    const pending = peer.request('invoke', null);
    const error = { code: 'APPLICATION_PLUGIN_UNAVAILABLE', message: 'Plugin exited' };

    receive({ protocol: 1, generation: 'gen-1', kind: 'response', requestId: '1', ok: false, error: { ...error, stack: 'remote stack' } });
    receive({ protocol: 1, generation: 'gen-1', kind: 'response', requestId: '1', ok: false, error: { ...error, extra: true } });
    receive({ protocol: 1, generation: 'gen-1', kind: 'response', requestId: '1', ok: true, payload: 'pong' });

    await expect(pending).resolves.toBe('pong');
  });

  it('ignores a hostile proxy response without invoking its traps', async () => {
    let receive: (input: unknown) => void = () => undefined;
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: (listener) => {
        receive = listener;
        return () => undefined;
      },
    });
    const pending = peer.request('invoke', null);
    let trapCount = 0;
    const hostile = new Proxy({}, {
      get() { trapCount += 1; throw new Error('get trap'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('descriptor trap'); },
      getPrototypeOf() { trapCount += 1; throw new Error('prototype trap'); },
      ownKeys() { trapCount += 1; throw new Error('keys trap'); },
    });

    expect(() => receive(hostile)).not.toThrow();
    expect(trapCount).toBe(0);

    peer.close(new Error('closed'));
    await expect(pending).rejects.toThrow('closed');
  });

  it('normalizes a hostile synchronous send failure without invoking its traps', async () => {
    let trapCount = 0;
    const hostile = new Proxy({}, {
      get() { trapCount += 1; throw new Error('get trap'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('descriptor trap'); },
      getPrototypeOf() { trapCount += 1; throw new Error('prototype trap'); },
      ownKeys() { trapCount += 1; throw new Error('keys trap'); },
    });
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => { throw hostile; },
      subscribe: () => () => undefined,
    });

    await expect(peer.request('invoke', null)).rejects.toMatchObject({
      message: 'Application plugin runner failed',
    });
    expect(trapCount).toBe(0);
  });

  it('rejects the 257th pending request', async () => {
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: () => () => undefined,
    });
    const pending = Array.from({ length: 256 }, () => peer.request('invoke', null));

    await expect(peer.request('invoke', null)).rejects.toThrow(/pending/i);

    peer.close(new Error('APPLICATION_PLUGIN_UNAVAILABLE'));
    await Promise.allSettled(pending);
  });

  it('rejects pending and future requests with its terminal error after close', async () => {
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: () => () => undefined,
    });
    const error = new Error('APPLICATION_PLUGIN_UNAVAILABLE');
    const pending = peer.request('invoke', null);

    peer.close(error);

    await expect(pending).rejects.toBe(error);
    await expect(peer.request('invoke', null)).rejects.toBe(error);
  });

  it('settles pending requests when unsubscribe throws and closes only once', async () => {
    const unsubscribe = vi.fn(() => {
      throw new Error('unsubscribe failed');
    });
    const peer = createPluginProcessRpcPeer({
      generation: 'gen-1',
      send: () => undefined,
      subscribe: () => unsubscribe,
    });
    const error = new Error('APPLICATION_PLUGIN_UNAVAILABLE');
    const pending = peer.request('invoke', null);

    expect(() => peer.close(error)).not.toThrow();
    expect(() => peer.close(new Error('different error'))).not.toThrow();

    await expect(pending).rejects.toBe(error);
    await expect(peer.request('invoke', null)).rejects.toBe(error);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
