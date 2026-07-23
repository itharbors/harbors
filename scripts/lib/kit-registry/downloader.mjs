import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

import { encodeKitId } from '@itharbors/kit-core';

import { assertResolvedRegistryAsset } from './resolver.mjs';
import { fetchGitHubReleaseAsset } from './github-release-fetch.mjs';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

let sequence = 0;

export class KitArtifactDownloadError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KitArtifactDownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${context} must be a positive integer`);
  }
  return value;
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeChunk(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten === 0) throw new Error('Unable to make progress writing Kit artifact');
    offset += bytesWritten;
  }
}

export class KitArtifactDownloader {
  #storeRoot;
  #downloads;
  #fetch;
  #wait;
  #timeoutMs;
  #maxAttempts;
  #retryBaseMs;
  #maxArtifactBytes;

  constructor({
    storeRoot,
    fetchImpl = globalThis.fetch,
    wait = defaultWait,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  }) {
    if (typeof storeRoot !== 'string' || storeRoot.length === 0) {
      throw new TypeError('Store root is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (typeof wait !== 'function') throw new TypeError('wait must be a function');
    this.#storeRoot = path.resolve(storeRoot);
    this.#downloads = path.join(this.#storeRoot, 'downloads');
    this.#fetch = fetchImpl;
    this.#wait = wait;
    this.#timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.#maxAttempts = positiveInteger(maxAttempts, 'maxAttempts');
    this.#retryBaseMs = positiveInteger(retryBaseMs, 'retryBaseMs');
    this.#maxArtifactBytes = positiveInteger(maxArtifactBytes, 'maxArtifactBytes');
  }

  async #downloadAttempt(asset) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Kit artifact download timed out'));
    }, this.#timeoutMs);
    let response;
    try {
      try {
        response = await fetchGitHubReleaseAsset(this.#fetch, asset.url, {
          method: 'GET',
          headers: { Accept: 'application/octet-stream' },
          signal: controller.signal,
        });
      } catch (error) {
        throw new KitArtifactDownloadError(
          timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
          timedOut ? 'Kit artifact download timed out' : 'Kit artifact request failed',
          { retryable: true, cause: error },
        );
      }
      if (!response.ok) {
        throw new KitArtifactDownloadError(
          'HTTP_ERROR',
          `Kit artifact request failed with HTTP ${response.status}`,
          { retryable: response.status >= 500 && response.status <= 599 },
        );
      }
      const declared = response.headers.get('content-length');
      if (declared !== null) {
        const length = Number(declared);
        if (Number.isFinite(length) && length !== asset.size) {
          throw new KitArtifactDownloadError(
            'SIZE_MISMATCH',
            'Kit artifact Content-Length does not match release metadata',
          );
        }
      }
      if (!response.body) {
        throw new KitArtifactDownloadError('NETWORK_ERROR', 'Kit artifact response body is empty', {
          retryable: true,
        });
      }

      await mkdir(this.#downloads, { recursive: true, mode: 0o700 });
      await chmod(this.#downloads, 0o700);
      const destination = path.join(
        this.#downloads,
        `${encodeKitId(asset.id)}-${asset.version}-${process.pid}-${sequence += 1}.download`,
      );
      const handle = await open(destination, 'wx', 0o600);
      let complete = false;
      try {
        const reader = response.body.getReader();
        const hash = createHash('sha256');
        let size = 0;
        try {
          while (true) {
            let chunk;
            try {
              chunk = await reader.read();
            } catch (error) {
              throw new KitArtifactDownloadError(
                timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
                timedOut ? 'Kit artifact download timed out' : 'Kit artifact stream failed',
                { retryable: true, cause: error },
              );
            }
            if (chunk.done) break;
            const buffer = Buffer.from(chunk.value);
            size += buffer.length;
            if (size > asset.size || size > this.#maxArtifactBytes) {
              await reader.cancel().catch(() => undefined);
              throw new KitArtifactDownloadError(
                'SIZE_MISMATCH',
                'Kit artifact bytes exceed release metadata',
              );
            }
            hash.update(buffer);
            try {
              await writeChunk(handle, buffer);
            } catch (error) {
              throw new KitArtifactDownloadError(
                'LOCAL_IO_ERROR',
                'Unable to write Kit artifact download',
                { cause: error },
              );
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (size !== asset.size) {
          throw new KitArtifactDownloadError(
            'SIZE_MISMATCH',
            'Kit artifact size does not match release metadata',
          );
        }
        const sha256 = hash.digest('hex');
        if (sha256 !== asset.sha256) {
          throw new KitArtifactDownloadError(
            'DIGEST_MISMATCH',
            'Kit artifact SHA-256 does not match release metadata',
          );
        }
        await handle.sync();
        complete = true;
        return { path: destination, size, sha256 };
      } finally {
        await handle.close();
        if (!complete) await rm(destination, { force: true });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async download(value) {
    const asset = assertResolvedRegistryAsset(value);
    if (asset.size > this.#maxArtifactBytes) {
      throw new KitArtifactDownloadError(
        'ARTIFACT_TOO_LARGE',
        `Kit artifact exceeds ${this.#maxArtifactBytes} bytes`,
      );
    }
    let lastError;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const result = await this.#downloadAttempt(asset);
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error instanceof KitArtifactDownloadError
          ? error
          : new KitArtifactDownloadError('LOCAL_IO_ERROR', 'Kit artifact download failed', {
            cause: error,
          });
        if (!lastError.retryable || attempt === this.#maxAttempts) throw lastError;
        await this.#wait(this.#retryBaseMs * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }
}
