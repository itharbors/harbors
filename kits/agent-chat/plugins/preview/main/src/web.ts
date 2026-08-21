import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';

import { validatePreviewLink } from './uri.js';

export interface WebPageContent {
  kind: 'url';
  url: string;
  title?: string;
  snapshotHtml?: string;
  snapshotBaseUrl?: string;
  snapshotError?: string;
  directAllowed: boolean;
}

export interface WebFetchOptions {
  lookupImpl?: LookupImpl;
  requestImpl?: RequestImpl;
  timeoutMs?: number;
  maxBytes?: number;
}

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_REDIRECTS = 5;

interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
}

interface RequestOptions {
  signal: AbortSignal;
  lookup: LookupFunction;
}

type Address = { address: string; family: 4 | 6 };
type LookupImpl = (hostname: string, options: { all: true; verbatim: true }) => Promise<Address[]>;

export type RequestImpl = (url: URL, options: RequestOptions) => Promise<RawResponse>;

function nodeRequest(url: URL, options: RequestOptions): Promise<RawResponse> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'text/html, application/xhtml+xml;q=0.9', 'accept-encoding': 'identity' },
      lookup: options.lookup,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (response) => resolve({
      statusCode: response.statusCode || 0,
      headers: response.headers,
      body: response,
    }));
    const abort = () => request.destroy(new Error('网页加载超时'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    request.once('error', reject);
    request.end();
  });
}

function privateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
    || (a === 203 && b === 0) || a >= 224;
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0];
  const halves = normalized.split('::');
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

async function assertPublicUrl(value: URL, lookupImpl: LookupImpl): Promise<void> {
  if ((value.protocol !== 'http:' && value.protocol !== 'https:') || value.username || value.password) {
    throw new Error('网页地址必须是无用户信息的 HTTP(S) 公网地址');
  }
  const hostname = value.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal'
    || hostname === 'metadata' || hostname === 'instance-data.ec2.internal') {
    throw new Error('拒绝访问本地主机或云元数据地址');
  }
  const addressKind = isIP(hostname);
  const addresses = addressKind
    ? [{ address: hostname, family: addressKind }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => entry.family === 4
    ? privateIpv4(entry.address)
    : privateIpv6(entry.address))) {
    throw new Error('拒绝访问非公网地址');
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '网页加载超时';
  return error instanceof Error ? error.message : String(error);
}

async function readBodyText(response: RawResponse, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new Error(`网页内容超过 ${maxBytes} 字节限制`);
    }
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function titleFromUrl(url: URL): string {
  return url.pathname.split('/').pop() || '链接预览';
}

/** Fetch only a validated HTTP(S) page for the isolated preview snapshot. */
export async function fetchWebPage(payload: unknown, options: WebFetchOptions = {}): Promise<WebPageContent> {
  const validation = validatePreviewLink(payload);
  if ('error' in validation || (validation.link.protocol !== 'http' && validation.link.protocol !== 'https')) {
    const href = 'error' in validation ? validation.originalHref || '' : validation.link.href;
    return { kind: 'url', url: href, title: href || '链接预览', snapshotError: '仅支持获取 HTTP(S) 网页', directAllowed: false };
  }

  const url = validation.link.href;
  const title = validation.link.text || titleFromUrl(validation.link.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  const lookupImpl = (options.lookupImpl || lookup) as unknown as LookupImpl;
  const requestImpl = options.requestImpl || nodeRequest;
  try {
    let currentUrl = validation.link.url;
    let response: RawResponse;
    for (let redirects = 0; ; redirects += 1) {
      const hostname = currentUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const addressKind = isIP(hostname);
      const addresses: Address[] = addressKind
        ? [{ address: hostname, family: addressKind as 4 | 6 }]
        : await lookupImpl(hostname, { all: true, verbatim: true });
      await assertPublicUrl(currentUrl, async () => addresses as Address[]);
      const selected = addresses[0];
      response = await requestImpl(currentUrl, {
        signal: controller.signal,
        lookup: (_hostname, requestOptions, callback) => {
          if (requestOptions.all) callback(null, [{ address: selected.address, family: selected.family }]);
          else callback(null, selected.address, selected.family);
        },
      });
      if (response.statusCode < 300 || response.statusCode >= 400) break;
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) throw new Error(`网页重定向超过 ${WEB_FETCH_MAX_REDIRECTS} 次限制`);
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) throw new Error('网页重定向缺少目标地址');
      const nextUrl = new URL(location, currentUrl);
      if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
        throw new Error('拒绝 HTTPS 降级到 HTTP');
      }
      currentUrl = nextUrl;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`网页请求失败（HTTP ${response.statusCode}）`);
    }
    const parsedFinalUrl = currentUrl;
    const contentTypeHeader = response.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] || '' : contentTypeHeader || '';
    if (!/^text\/html(?:\s*;|\s*$)|^application\/xhtml\+xml(?:\s*;|\s*$)/i.test(contentType)) {
      throw new Error(`网页响应不是 HTML（${contentType || '缺少 Content-Type'}）`);
    }
    const maxBytes = options.maxBytes ?? WEB_FETCH_MAX_BYTES;
    const contentLengthHeader = response.headers['content-length'];
    const contentLength = Number(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader || '');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`网页内容超过 ${maxBytes} 字节限制`);
    }
    const html = await readBodyText(response, maxBytes);
    return {
      kind: 'url',
      url,
      title,
      snapshotHtml: html,
      snapshotBaseUrl: parsedFinalUrl.href,
      directAllowed: true,
    };
  } catch (error) {
    return { kind: 'url', url, title, snapshotError: errorMessage(error), directAllowed: false };
  } finally {
    clearTimeout(timeout);
  }
}
