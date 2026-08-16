import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 入站通知处理函数。
 */
export type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type InboundMessage = JsonRpcResponse | JsonRpcNotification;

/**
 * Codex app-server 的 JSONL 客户端。
 *
 * 负责进程生命周期、JSON-RPC 请求/响应匹配以及入站通知分发。
 * 不包含任何线程/turn 业务逻辑。
 */
export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private buffer = '';
  private started = false;
  private dead = false;
  private exitHandler: ((error?: Error) => void) | null = null;

  setExitHandler(handler: (error?: Error) => void): void {
    this.exitHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const codexBin = process.env.CODEX_BIN || 'codex';
    const daemonSocket = process.env.HARBORS_CODEX_APP_SERVER_SOCKET || join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
    const args = existsSync(daemonSocket)
      ? ['app-server', 'proxy', '--sock', daemonSocket]
      : ['app-server'];
    this.process = spawn(codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer | string) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data: Buffer | string) => {
      const msg = data.toString().trim();
      if (msg) console.error('[codex]', msg);
    });

    this.process.on('error', (err: Error) => {
      console.error('[codex] process error:', err);
      this.handleProcessDeath(err);
    });

    this.process.on('exit', (code: number | null) => {
      console.error(`[codex] exited with code ${code}`);
      this.handleProcessDeath(new Error(`Codex app-server exited with code ${code}`));
    });

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'harbors-agent', version: '0.0.1' },
      });
      this.notify('initialized', {});
    } catch (err) {
      this.cleanupAfterFailure();
      throw err;
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const stdin = this.process?.stdin;
      if (!this.started || !stdin?.writable) {
        reject(new Error('Codex app-server is not running'));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const request = { jsonrpc: '2.0', id, method, params };
      stdin.write(JSON.stringify(request) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    const stdin = this.process?.stdin;
    if (!this.started || !stdin?.writable) return;

    const notification = { jsonrpc: '2.0', method, params };
    stdin.write(JSON.stringify(notification) + '\n');
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  stop(): void {
    if (this.dead) {
      this.process = null;
      this.started = false;
      return;
    }
    this.dead = true;
    this.rejectAllPending(new Error('Client stopped'));
    this.process?.kill();
    this.process = null;
    this.started = false;
  }

  private cleanupAfterFailure(): void {
    this.rejectAllPending(new Error('Client start failed'));
    this.process?.kill();
    this.process = null;
    this.started = false;
    this.dead = true;
  }

  private handleProcessDeath(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.started = false;
    this.process = null;
    this.rejectAllPending(error);
    this.exitHandler?.(error);
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: InboundMessage;
      try {
        msg = JSON.parse(trimmed) as InboundMessage;
      } catch {
        continue;
      }

      if ('id' in msg && msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || 'Unknown error'));
          } else {
            entry.resolve(msg.result);
          }
        }
      } else if ('method' in msg && msg.method) {
        const handler = this.notificationHandlers.get(msg.method);
        if (handler) {
          try {
            handler(msg.params);
          } catch (err) {
            console.error('[codex] notification handler error:', err);
          }
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
