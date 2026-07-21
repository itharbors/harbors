import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { SSEChannel } from '../../src/sse/channel';
import { handleSSE } from '../../src/sse/handler';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

function mockResponse(): ServerResponse {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const res = writable as unknown as ServerResponse;
  res.writeHead = () => res;
  res.write = (data: string) => { res.emit('written', data); return true; };
  (res as any).chunks = chunks;
  return res;
}

describe('SSEChannel', () => {
  let channel: SSEChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = new SSEChannel();
  });

  afterEach(() => {
    channel.closeAll();
    vi.useRealTimers();
  });

  it('adds and removes a client', () => {
    const res = mockResponse();
    channel.addClient('s1', res);
    channel.removeClient('s1', res);
  });

  it('removes failed writers and closes every connection for a session', () => {
    const good = mockResponse();
    const failed = mockResponse();
    const end = vi.spyOn(good, 'end');
    failed.write = () => { throw new Error('socket closed'); };
    channel.addClient('s1', good);
    channel.addClient('s1', failed);

    channel.broadcast('s1', {
      type: 'menu-changed',
      menuTree: [],
      applicationMenuTree: [],
      kitMenuTree: [],
    });

    expect(channel.clientCount('s1')).toBe(1);
    channel.closeSession('s1');
    expect(end).toHaveBeenCalled();
    expect(channel.clientCount('s1')).toBe(0);
  });

  it('queues business events while blocked and closes on the 65th queued event', () => {
    const res = mockResponse();
    const writes: string[] = [];
    const end = vi.spyOn(res, 'end');
    let first = true;
    res.write = (data: string) => {
      writes.push(data);
      if (first) {
        first = false;
        return false;
      }
      return true;
    };
    const disconnected = vi.fn();
    channel.onSessionDisconnected(disconnected);
    channel.addClient('s1', res);

    channel.broadcast('s1', { type: 'heartbeat', ts: 0 });
    channel.broadcast('s1', { type: 'heartbeat', ts: 1 });
    channel.broadcast('s1', { type: 'heartbeat', ts: 2 });
    expect(writes).toHaveLength(1);

    res.emit('drain');
    expect(writes.map((value) => JSON.parse(value.slice(6)).ts)).toEqual([0, 1, 2]);

    first = true;
    channel.broadcast('s1', { type: 'heartbeat', ts: 3 });
    for (let index = 0; index < 65; index += 1) {
      channel.broadcast('s1', { type: 'heartbeat', ts: index + 4 });
    }
    expect(end).toHaveBeenCalled();
    expect(channel.clientCount('s1')).toBe(0);
    expect(disconnected).toHaveBeenCalledWith('s1');
  });

  it('writes a comment heartbeat every fifteen seconds and cleans up on request close', () => {
    const req = new Writable() as unknown as IncomingMessage;
    Object.defineProperty(req, 'url', { value: '/sse/s1' });
    const res = mockResponse();
    const received: string[] = [];
    res.write = (data: string) => { received.push(data); return true; };

    handleSSE(req, res, channel);
    vi.advanceTimersByTime(15_000);

    expect(received).toContainEqual(expect.stringMatching(/^: heartbeat \d+\n\n$/));
    req.emit('close');
    expect(channel.clientCount('s1')).toBe(0);
  });

  it('broadcasts to all clients of a session', () => {
    const received: string[] = [];
    const res1 = mockResponse();
    const res2 = mockResponse();

    res1.write = (data: string) => { received.push(data); return true; };
    res2.write = (data: string) => { received.push(data); return true; };

    channel.addClient('s1', res1);
    channel.addClient('s1', res2);

    channel.broadcast('s1', { type: 'heartbeat', ts: 123 });

    expect(received.length).toBe(2);
    expect(received[0]).toContain('heartbeat');
    expect(received[1]).toContain('heartbeat');
  });

  it('does not broadcast to other sessions', () => {
    const received: string[] = [];
    const res1 = mockResponse();
    const res2 = mockResponse();

    res1.write = (data: string) => { received.push(data); return true; };
    res2.write = (data: string) => { received.push(data); return true; };

    channel.addClient('s1', res1);
    channel.addClient('s2', res2);

    channel.broadcast('s1', {
      type: 'menu-changed',
      menuTree: [],
      applicationMenuTree: [],
      kitMenuTree: [],
    });

    expect(received.length).toBe(1);
  });

  it('formats SSE messages correctly', () => {
    const received: string[] = [];
    const res = mockResponse();
    res.write = (data: string) => { received.push(data); return true; };

    channel.addClient('s1', res);
    channel.broadcast('s1', {
      type: 'menu-changed',
      menuTree: [],
      applicationMenuTree: [],
      kitMenuTree: [],
    });

    expect(received[0]).toBe('data: {"protocolVersion":1,"type":"menu-changed","menuTree":[],"applicationMenuTree":[],"kitMenuTree":[]}\n\n');
  });
});
