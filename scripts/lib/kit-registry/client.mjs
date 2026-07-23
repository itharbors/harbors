const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

class RegistryClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RegistryClientError';
    this.code = code;
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${context} must be a positive integer`);
  }
  return value;
}

function parseRegistryUrl(value, allowLoopbackHttp) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Registry URL is required');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Registry URL must be an absolute HTTPS URL');
  }
  const loopbackHttp = allowLoopbackHttp
    && url.protocol === 'http:'
    && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.hash) {
    throw new TypeError('Registry URL must be HTTPS without credentials or fragments');
  }
  return url.href;
}

function emptySnapshot(error) {
  return {
    index: null,
    source: 'none',
    stale: true,
    validatedAt: null,
    ...(error === undefined ? {} : { error }),
  };
}

function cacheSnapshot(cached, { stale, error } = {}) {
  return {
    index: cached.index,
    source: 'cache',
    stale: stale ?? true,
    validatedAt: cached.metadata.validatedAt,
    ...(error === undefined ? {} : { error }),
  };
}

function networkSnapshot(cached) {
  return {
    index: cached.index,
    source: 'network',
    stale: false,
    validatedAt: cached.metadata.validatedAt,
  };
}

function publicError(error, timedOut) {
  if (timedOut) return { code: 'TIMEOUT', message: 'Registry refresh timed out' };
  if (error instanceof RegistryClientError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'NETWORK_ERROR', message: 'Registry refresh failed' };
}

async function readLimitedJson(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new RegistryClientError(
        'RESPONSE_TOO_LARGE',
        `Registry response exceeds ${maxBytes} bytes`,
      );
    }
  }
  if (!response.body) {
    throw new RegistryClientError('INVALID_REGISTRY', 'Registry response body is empty');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryClientError(
          'RESPONSE_TOO_LARGE',
          `Registry response exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    throw new RegistryClientError('INVALID_REGISTRY', 'Registry response is not valid JSON', {
      cause: error,
    });
  }
}

export class KitRegistryClient {
  #registryUrl;
  #cache;
  #fetch;
  #now;
  #refreshIntervalMs;
  #timeoutMs;
  #maxResponseBytes;
  #queue = Promise.resolve();

  constructor({
    registryUrl,
    cache,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    allowLoopbackHttp = false,
  }) {
    if (!cache || typeof cache.read !== 'function' || typeof cache.writeVerified !== 'function') {
      throw new TypeError('Registry cache is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#registryUrl = parseRegistryUrl(registryUrl, allowLoopbackHttp);
    this.#cache = cache;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#refreshIntervalMs = positiveInteger(refreshIntervalMs, 'refreshIntervalMs');
    this.#timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.#maxResponseBytes = positiveInteger(maxResponseBytes, 'maxResponseBytes');
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #matchingCache() {
    const cached = await this.#cache.read();
    return cached?.metadata.registryUrl === this.#registryUrl ? cached : null;
  }

  async snapshot() {
    const cached = await this.#matchingCache();
    if (!cached) return emptySnapshot();
    const age = this.#now() - Date.parse(cached.metadata.validatedAt);
    return cacheSnapshot(cached, {
      stale: !(age >= 0 && age < this.#refreshIntervalMs),
    });
  }

  async refresh({ force = false } = {}) {
    return this.#enqueue(async () => {
      const cached = await this.#matchingCache();
      if (!force && cached) {
        const age = this.#now() - Date.parse(cached.metadata.validatedAt);
        if (age >= 0 && age < this.#refreshIntervalMs) {
          return cacheSnapshot(cached, { stale: false });
        }
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Registry refresh timed out'));
      }, this.#timeoutMs);
      try {
        const headers = { Accept: 'application/json' };
        if (cached?.metadata.etag) headers['If-None-Match'] = cached.metadata.etag;
        const response = await this.#fetch(this.#registryUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'error',
        });
        const validatedAt = new Date(this.#now()).toISOString();
        if (response.status === 304) {
          if (!cached) {
            throw new RegistryClientError(
              'INVALID_REGISTRY',
              'Registry returned 304 without a matching cache',
            );
          }
          const renewed = await this.#cache.writeVerified({
            registryUrl: this.#registryUrl,
            etag: response.headers.get('etag') || cached.metadata.etag,
            index: cached.index,
            validatedAt,
          });
          return cacheSnapshot(renewed, { stale: false });
        }
        if (!response.ok) {
          throw new RegistryClientError(
            'HTTP_ERROR',
            `Registry refresh failed with HTTP ${response.status}`,
          );
        }
        const rawIndex = await readLimitedJson(response, this.#maxResponseBytes);
        let verified;
        try {
          verified = await this.#cache.writeVerified({
            registryUrl: this.#registryUrl,
            etag: response.headers.get('etag') || undefined,
            index: rawIndex,
            validatedAt,
          });
        } catch (error) {
          throw new RegistryClientError(
            'INVALID_REGISTRY',
            'Registry response failed schema validation',
            { cause: error },
          );
        }
        return networkSnapshot(verified);
      } catch (error) {
        const failure = publicError(error, timedOut);
        return cached
          ? cacheSnapshot(cached, { stale: true, error: failure })
          : emptySnapshot(failure);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
