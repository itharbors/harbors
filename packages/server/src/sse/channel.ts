import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_VERSION, type SSEEnvelope, type UnversionedSSEEnvelope } from '@ce/plugin-types';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_QUEUED_EVENTS = 64;

interface ClientConnection {
  sessionId: string;
  res: ServerResponse;
  req?: IncomingMessage;
  blocked: boolean;
  queue: string[];
  heartbeat: ReturnType<typeof setInterval>;
  closed: boolean;
  onDrain: () => void;
  onClose: () => void;
}

export class SSEChannel {
  private readonly clients = new Map<string, Set<ClientConnection>>();
  private readonly byResponse = new WeakMap<ServerResponse, ClientConnection>();
  private readonly disconnectListeners = new Set<(sessionId: string) => void>();

  addClient(sessionId: string, res: ServerResponse, req?: IncomingMessage): void {
    const existing = this.byResponse.get(res);
    if (existing) this.closeConnection(existing, false);

    const connection = {} as ClientConnection;
    connection.sessionId = sessionId;
    connection.res = res;
    connection.req = req;
    connection.blocked = false;
    connection.queue = [];
    connection.closed = false;
    connection.onDrain = () => this.flush(connection);
    connection.onClose = () => this.closeConnection(connection, false);
    connection.heartbeat = setInterval(() => this.writeHeartbeat(connection), HEARTBEAT_INTERVAL_MS);

    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    set.add(connection);
    this.byResponse.set(res, connection);
    res.on('drain', connection.onDrain);
    res.on('error', connection.onClose);
    res.on('close', connection.onClose);
    req?.on('aborted', connection.onClose);
    req?.on('close', connection.onClose);
  }

  removeClient(sessionId: string, res: ServerResponse): void {
    const connection = this.byResponse.get(res);
    if (connection?.sessionId === sessionId) this.closeConnection(connection, false);
  }

  sendToClient(sessionId: string, res: ServerResponse, event: UnversionedSSEEnvelope): void {
    const connection = this.byResponse.get(res);
    if (!connection || connection.sessionId !== sessionId) return;
    this.writeBusiness(connection, serializeEvent(event));
  }

  broadcast(sessionId: string, event: UnversionedSSEEnvelope): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    const data = serializeEvent(event);
    for (const connection of [...set]) {
      this.writeBusiness(connection, data);
    }
  }

  clientCount(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  onSessionDisconnected(listener: (sessionId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  closeSession(sessionId: string): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    for (const connection of [...set]) this.closeConnection(connection, true);
  }

  closeAll(): void {
    for (const sessionId of [...this.clients.keys()]) this.closeSession(sessionId);
  }

  private writeBusiness(connection: ClientConnection, data: string): void {
    if (connection.closed) return;
    if (connection.blocked) {
      if (connection.queue.length >= MAX_QUEUED_EVENTS) {
        this.closeConnection(connection, true);
        return;
      }
      connection.queue.push(data);
      return;
    }
    const writable = this.safeWrite(connection, data);
    if (writable === false) connection.blocked = true;
  }

  private writeHeartbeat(connection: ClientConnection): void {
    if (connection.closed || connection.blocked) return;
    const writable = this.safeWrite(connection, `: heartbeat ${Date.now()}\n\n`);
    if (writable === false) connection.blocked = true;
  }

  private flush(connection: ClientConnection): void {
    if (connection.closed) return;
    connection.blocked = false;
    while (connection.queue.length > 0) {
      const data = connection.queue.shift()!;
      const writable = this.safeWrite(connection, data);
      if (writable === false) {
        connection.blocked = true;
        return;
      }
      if (connection.closed) return;
    }
  }

  private safeWrite(connection: ClientConnection, data: string): boolean | undefined {
    try {
      return connection.res.write(data);
    } catch {
      this.closeConnection(connection, true);
      return undefined;
    }
  }

  private closeConnection(connection: ClientConnection, endResponse: boolean): void {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.heartbeat);
    connection.queue.length = 0;
    connection.res.off('drain', connection.onDrain);
    connection.res.off('error', connection.onClose);
    connection.res.off('close', connection.onClose);
    connection.req?.off('aborted', connection.onClose);
    connection.req?.off('close', connection.onClose);
    this.byResponse.delete(connection.res);

    const set = this.clients.get(connection.sessionId);
    set?.delete(connection);
    if (endResponse) {
      try { connection.res.end(); } catch { /* socket already closed */ }
    }
    if (set && set.size === 0) {
      this.clients.delete(connection.sessionId);
      for (const listener of this.disconnectListeners) listener(connection.sessionId);
    }
  }
}

function serializeEvent(event: UnversionedSSEEnvelope): string {
  const versioned = { protocolVersion: PROTOCOL_VERSION, ...event } as SSEEnvelope;
  return `data: ${JSON.stringify(versioned)}\n\n`;
}
