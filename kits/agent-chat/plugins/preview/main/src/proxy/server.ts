import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

const HOST = '0.0.0.0';
const SESSION_TTL_MS = 30 * 60 * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_REQUESTS = 100;
const MAX_SESSIONS = 64;
const MAX_RESOURCES = 512;
const MAX_CONCURRENT_REQUESTS = 32;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const ROOT = '/preview-proxy';
const FORCED_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

type Address = { address: string; family: 4 | 6 };
type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Address[]>;
type RawResponse = { statusCode: number; headers: http.IncomingHttpHeaders; body: NodeJS.ReadableStream };
type RequestImpl = (url: URL, options: {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
  lookup: LookupFunction;
}) => Promise<RawResponse>;

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
  expiresAt?: number;
}

interface Session {
  id: string;
  target: URL;
  createdAt: number;
  lastUsedAt: number;
  requests: number;
  cookies: Cookie[];
  resources: Map<string, URL>;
  reverseResources: Map<string, string>;
}

export interface ProxySessionInfo {
  sessionId: string;
  port: number;
  path: string;
  expiresAt: number;
}

export interface ProxyServiceOptions {
  lookupImpl?: Lookup;
  requestImpl?: RequestImpl;
  now?: () => number;
  sessionTtlMs?: number;
  idleCloseMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxRequests?: number;
  maxSessions?: number;
  maxResources?: number;
  maxConcurrentRequests?: number;
  cleanupIntervalMs?: number;
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
    || (a === 203 && b === 0) || a >= 224;
}

function privateIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%', 1)[0];
  const halves = value.split('::');
  if (halves.length > 2) return true;
  const parsePart = (part: string): number[] => part ? part.split(':').flatMap((segment, index, segments) => {
    if (!segment) return [];
    if (segment.includes('.')) {
      if (index !== segments.length - 1) return [0x10000];
      const octets = segment.split('.').map(Number);
      return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
        ? [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]] : [0x10000];
    }
    return /^[0-9a-f]{1,4}$/.test(segment) ? [Number.parseInt(segment, 16)] : [0x10000];
  }) : [];
  const left = parsePart(halves[0]);
  const right = halves.length === 2 ? parsePart(halves[1]) : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : [...left];
  if (words.length !== 8 || words.some((word) => word > 0xffff)) return true;
  const allZero = words.every((word) => word === 0);
  if (allZero || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) return true;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return privateIpv4(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`);
  }
  if (words.slice(0, 6).every((word) => word === 0)) return true;
  if (words[0] === 0x2002) return privateIpv4(`${words[2] >>> 8}.${words[2] & 255}.${words[3] >>> 8}.${words[3] & 255}`);
  return words[0] === 0x2001 && words[1] === 0;
}

async function publicAddresses(url: URL, lookupImpl: Lookup): Promise<Address[]> {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('仅支持无凭据的 HTTP(S) 公网地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata'
    || hostname === 'metadata.google.internal' || hostname === 'instance-data.ec2.internal') {
    throw new Error('拒绝访问本地主机或云元数据地址');
  }
  const kind = isIP(hostname);
  const addresses = kind ? [{ address: hostname, family: kind as 4 | 6 }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => entry.family === 4 ? privateIpv4(entry.address) : privateIpv6(entry.address))) {
    throw new Error('拒绝访问非公网地址');
  }
  return addresses;
}

function nodeRequest(url: URL, options: Parameters<NonNullable<RequestImpl>>[1]): Promise<RawResponse> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: { ...options.headers, 'accept-encoding': 'identity' },
      lookup: options.lookup,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (res) => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: res }));
    const abort = () => req.destroy(new Error('网页请求超时'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    req.once('error', reject);
    req.end();
  });
}

function safeError(error: unknown): string {
  if (error instanceof Error && (error.message === '网页请求超时' || error.message.startsWith('网页内容超过'))) return error.message;
  if (error instanceof Error && /^(仅支持|拒绝访问|网页重定向|只支持)/.test(error.message)) return error.message;
  return '网页代理暂时无法加载此内容 / Preview proxy could not load this content';
}

function parseSetCookie(value: string, url: URL, now: number): Cookie | undefined {
  const parts = value.split(';').map((part) => part.trim());
  const pair = parts.shift();
  if (!pair) return undefined;
  const separator = pair.indexOf('=');
  if (separator <= 0) return undefined;
  const cookie: Cookie = {
    name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1),
    domain: url.hostname.toLowerCase(), path: url.pathname.split('/').slice(0, -1).join('/') || '/', secure: false, hostOnly: true,
  };
  let domainAttribute: string | undefined;
  for (const part of parts) {
    const [rawName, ...rawValue] = part.split('=');
    const name = rawName.toLowerCase();
    const valuePart = rawValue.join('=').trim();
    if (name === 'domain' && valuePart) domainAttribute = valuePart.replace(/^\./, '').toLowerCase();
    else if (name === 'path' && valuePart.startsWith('/')) cookie.path = valuePart;
    else if (name === 'secure') cookie.secure = true;
    else if (name === 'max-age') {
      const seconds = Number(valuePart);
      if (Number.isFinite(seconds)) cookie.expiresAt = now + Math.max(0, seconds) * 1000;
    } else if (name === 'expires') {
      const date = Date.parse(valuePart);
      if (Number.isFinite(date)) cookie.expiresAt = date;
    }
  }
  // The first version deliberately only accepts host-only cookies. A Domain
  // attribute is accepted when it names this exact response host, but never
  // when it broadens the cookie to a parent or sibling domain.
  if (domainAttribute && domainAttribute !== url.hostname.toLowerCase()) return undefined;
  if (domainAttribute) cookie.domain = domainAttribute;
  return cookie;
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function cookieHeader(session: Session, url: URL, now: number): string | undefined {
  session.cookies = session.cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
  const host = url.hostname.toLowerCase();
  const values = session.cookies.filter((cookie) => (cookie.hostOnly ? host === cookie.domain : (host === cookie.domain || host.endsWith(`.${cookie.domain}`)))
    && cookiePathMatches(url.pathname, cookie.path) && (!cookie.secure || url.protocol === 'https:'))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return values.length ? values.join('; ') : undefined;
}

function setCookies(session: Session, response: RawResponse, url: URL, now: number): void {
  const values = response.headers['set-cookie'];
  const list = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of list) {
    const cookie = parseSetCookie(value, url, now);
    if (!cookie) continue;
    session.cookies = session.cookies.filter((old) => !(old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path));
    if (cookie.expiresAt === undefined || cookie.expiresAt > now) session.cookies.push(cookie);
  }
}

async function readBody(body: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error(`网页内容超过 ${maxBytes} 字节限制`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function isSkippable(value: string): boolean {
  return /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value.trim());
}

function rewriteUrl(value: string, base: URL, register: (url: URL) => string): string {
  const raw = value.trim();
  if (!raw || isSkippable(raw)) return value;
  let absolute: URL;
  try {
    absolute = new URL(raw, base);
  } catch {
    return value;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return value;
  absolute.hash = '';
  const path = register(absolute);
  const hash = new URL(raw, base).hash;
  return path + hash;
}

function rewriteHtml(body: string, base: URL, register: (url: URL) => string): string {
  let output = body.replace(/<base\b[^>]*>/gi, '');
  output = output.replace(/<meta\b[^>]*http-equiv\s*=\s*(['"])content-security-policy\1[^>]*>/gi, '');
  output = output.replace(/\s([a-z]+)=(['"])(.*?)\2/gi, (all, name: string, quote: string, value: string) => {
    if (!/^(?:href|src|action|poster|cite|formaction)$/i.test(name)) return all;
    return ` ${name}=${quote}${rewriteUrl(value, base, register)}${quote}`;
  });
  output = output.replace(/\s(srcset)=(['"])(.*?)\2/gi, (all, name: string, quote: string, value: string) => {
    const rewritten = value.split(',').map((entry) => {
      const match = entry.trim().match(/^(\S+)(\s+.*)?$/);
      return match ? `${rewriteUrl(match[1], base, register)}${match[2] || ''}` : entry;
    }).join(', ');
    return ` ${name}=${quote}${rewritten}${quote}`;
  });
  return output;
}

function rewriteCss(body: string, base: URL, register: (url: URL) => string): string {
  return body.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, quote: string, value: string) => {
    return `url(${quote}${rewriteUrl(value, base, register)}${quote})`;
  }).replace(/(@import\s+)(['"])(.*?)\2/gi, (all, prefix: string, quote: string, value: string) => {
    return `${prefix}${quote}${rewriteUrl(value, base, register)}${quote}`;
  });
}

function contentType(headers: http.IncomingHttpHeaders): string {
  const value = headers['content-type'];
  return (Array.isArray(value) ? value[0] : value) || 'application/octet-stream';
}

function isHtml(type: string): boolean { return /^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(type); }
function isCss(type: string): boolean { return /^text\/css(?:;|$)/i.test(type); }
function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export class ProxyService {
  private readonly sessions = new Map<string, Session>();
  private readonly lookupImpl: Lookup;
  private readonly requestImpl: RequestImpl;
  private readonly now: () => number;
  private server?: http.Server;
  private port?: number;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private startPromise?: Promise<number>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private activeRequests = 0;
  private readonly options: Required<Pick<ProxyServiceOptions, 'sessionTtlMs' | 'idleCloseMs' | 'timeoutMs' | 'maxBodyBytes' | 'maxRedirects' | 'maxRequests' | 'maxSessions' | 'maxResources' | 'maxConcurrentRequests' | 'cleanupIntervalMs'>>;

  constructor(options: ProxyServiceOptions = {}) {
    this.lookupImpl = options.lookupImpl || (lookup as unknown as Lookup);
    this.requestImpl = options.requestImpl || nodeRequest;
    this.now = options.now || Date.now;
    this.options = {
      sessionTtlMs: options.sessionTtlMs ?? SESSION_TTL_MS,
      idleCloseMs: options.idleCloseMs ?? IDLE_CLOSE_MS,
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
      maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
      maxRequests: options.maxRequests ?? MAX_REQUESTS,
      maxSessions: options.maxSessions ?? MAX_SESSIONS,
      maxResources: options.maxResources ?? MAX_RESOURCES,
      maxConcurrentRequests: options.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS,
      cleanupIntervalMs: options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS,
    };
  }

  async openProxyPage(input: unknown): Promise<ProxySessionInfo> {
    if (!input || typeof input !== 'object' || typeof (input as { href?: unknown }).href !== 'string') throw new Error('需要有效的网页地址');
    const target = new URL((input as { href: string }).href);
    await publicAddresses(target, this.lookupImpl);
    this.cleanupExpiredSessions();
    if (this.sessions.size >= this.options.maxSessions) throw new Error('代理会话数量已达上限 / Preview session limit reached');
    const id = randomBytes(32).toString('base64url');
    const session: Session = {
      id, target, createdAt: this.now(), lastUsedAt: this.now(), requests: 0,
      cookies: [], resources: new Map(), reverseResources: new Map(),
    };
    session.resources.set('root', target);
    this.sessions.set(id, session);
    this.ensureCleanupTimer();
    let port: number;
    try {
      port = await this.ensureServer();
    } catch (error) {
      this.sessions.delete(id);
      this.scheduleIdleClose();
      throw error;
    }
    this.scheduleIdleClose();
    return { sessionId: id, port, path: `${ROOT}/${id}/root`, expiresAt: session.createdAt + this.options.sessionTtlMs };
  }

  async closeProxyPage(input: unknown): Promise<boolean> {
    const id = typeof input === 'string' ? input : input && typeof input === 'object' ? (input as { sessionId?: unknown }).sessionId : undefined;
    if (typeof id !== 'string') return false;
    const removed = this.sessions.delete(id);
    this.scheduleIdleClose();
    return removed;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (this.startPromise) {
      try { await this.startPromise; } catch { /* ensureServer performs rollback */ }
    }
    if (!this.server) return;
    const server = this.server;
    if (!server.listening) {
      this.server = undefined;
      this.port = undefined;
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private async ensureServer(): Promise<number> {
    if (this.server && this.port) return this.port;
    if (this.startPromise) return this.startPromise;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    const start = new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        if (this.server === server) {
          this.server = undefined;
          this.port = undefined;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (error) => {
          // Keep asynchronous server errors contained. The next open call can
          // create a fresh listener after the failed server is no longer live.
          if (this.server === server && !server.listening) {
            this.server = undefined;
            this.port = undefined;
          }
          console.error('[preview] proxy server error', error instanceof Error ? error.message : error);
        });
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('代理服务器启动失败'));
        this.port = address.port;
        resolve(address.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, HOST);
    });
    this.startPromise = start;
    try {
      return await start;
    } catch (error) {
      if (server.listening) {
        try { server.close(); } catch { /* already closed after listen failure */ }
      }
      throw error;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), this.options.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  private cleanupExpiredSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.options.sessionTtlMs) this.sessions.delete(id);
    }
    if (this.sessions.size === 0) this.scheduleIdleClose();
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessions.size > 0) return;
    this.idleTimer = setTimeout(() => { void this.close(); }, this.options.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end(message);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, '仅支持 GET/HEAD / Only GET and HEAD are supported');
      const parsed = new URL(req.url || '/', 'http://proxy.invalid');
      const match = parsed.pathname.match(new RegExp(`^${ROOT}/([^/]+)/([^/]+)$`));
      if (!match) return fail(404, '代理资源不存在 / Preview resource not found');
      const session = this.sessions.get(match[1]);
      if (!session) return fail(404, '代理会话不存在或已过期 / Preview session expired');
      const now = this.now();
      if (now - session.createdAt > this.options.sessionTtlMs || session.requests >= this.options.maxRequests) {
        this.sessions.delete(session.id);
        this.scheduleIdleClose();
        return fail(410, '代理会话已过期 / Preview session expired');
      }
      const target = session.resources.get(match[2]);
      if (!target) return fail(404, '代理资源不存在 / Preview resource not found');
      if (this.activeRequests >= this.options.maxConcurrentRequests) {
        return fail(429, '代理请求过多，请稍后重试 / Too many preview requests');
      }
      session.requests += 1;
      session.lastUsedAt = now;
      this.activeRequests += 1;
      try {
        await this.proxyRequest(session, target, req.method, res);
      } finally {
        this.activeRequests -= 1;
      }
    } catch (error) {
      if (!res.headersSent) fail(502, safeError(error));
      else res.end();
    }
  }

  private resourcePath(session: Session, target: URL): string {
    const key = target.href;
    const existingId = session.reverseResources.get(key);
    if (existingId) return `${ROOT}/${session.id}/${existingId}`;
    if (session.resources.size >= this.options.maxResources) throw new Error('网页资源数量已达上限 / Preview resource limit reached');
    const id = randomBytes(18).toString('base64url');
    session.resources.set(id, target);
    session.reverseResources.set(key, id);
    return `${ROOT}/${session.id}/${id}`;
  }

  private async proxyRequest(session: Session, initial: URL, method: 'GET' | 'HEAD', res: http.ServerResponse): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      let target = initial;
      let response: RawResponse;
      for (let redirect = 0; ; redirect += 1) {
        const addresses = await publicAddresses(target, this.lookupImpl);
        const selected = addresses[0];
        const headers: Record<string, string> = { accept: '*/*' };
        const cookies = cookieHeader(session, target, this.now());
        if (cookies) headers.cookie = cookies;
        response = await this.requestImpl(target, {
          method, headers, signal: controller.signal,
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
            else callback(null, selected.address, selected.family);
          },
        });
        setCookies(session, response, target, this.now());
        if (response.statusCode < 300 || response.statusCode >= 400) break;
        if (redirect >= this.options.maxRedirects) throw new Error('网页重定向次数超过限制');
        const location = headerValue(response.headers.location);
        if (!location) throw new Error('网页重定向缺少目标地址');
        const next = new URL(location, target);
        if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('拒绝 HTTPS 降级到 HTTP');
        target = next;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`网页请求失败（HTTP ${response.statusCode}）`);
      const type = contentType(response.headers);
      let body: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
      if (method !== 'HEAD') body = await readBody(response.body, this.options.maxBodyBytes);
      if (isHtml(type)) {
        const text = body.toString('utf8');
        body = Buffer.from(rewriteHtml(text, target, (url) => this.resourcePath(session, url)));
      } else if (isCss(type)) {
        body = Buffer.from(rewriteCss(body.toString('utf8'), target, (url) => this.resourcePath(session, url)));
      }
      res.statusCode = response.statusCode;
      res.setHeader('content-type', type);
      res.setHeader('content-length', String(body.length));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-content-type-options', 'nosniff');
      res.removeHeader('x-frame-options');
      // Always replace the target policy. This closes the same-host/different-port
      // CSRF boundary while allowing only resources that are already proxy-mapped.
      res.setHeader('content-security-policy', FORCED_CSP);
      if (method === 'HEAD') res.end();
      else res.end(body);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { privateIpv4, privateIpv6, publicAddresses, rewriteCss, rewriteHtml };
