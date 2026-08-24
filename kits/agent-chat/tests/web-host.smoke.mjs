import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const kitDirectory = process.cwd();
const repositoryRoot = await findRepositoryRoot(process.env.HARBORS_REPOSITORY_ROOT, kitDirectory);
const runnerUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'lib', 'web-host-runner.mjs')).href;
const { startWebHost } = await import(runnerUrl);

const host = await startWebHost({
  repositoryRoot,
  kitSources: [{ directory: kitDirectory, source: 'explicit' }],
  defaultKit: 'agent-chat',
  environment: { HARBORS_CREDENTIAL_MODE: 'off' },
});

try {
  const health = await host.health();
  assert.equal(health.status, 200);

  const catalogResponse = await fetch(`${host.baseUrl}/api/kits`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const kits = Array.isArray(catalog) ? catalog : catalog.kits;
  assert.ok(Array.isArray(kits), 'Kit catalog must expose a kits array');
  assert.ok(kits.some((kit) => kit?.id === 'agent-chat' && kit?.name === 'agent-chat'));

  const publicPath = await fetch(`${host.baseUrl}/kits/agent-chat`, { redirect: 'manual' });
  assert.equal(publicPath.status, 302);
  assert.equal(publicPath.headers.get('location'), '/?kit=agent-chat');

  const page = await fetchUntilReady(`${host.baseUrl}/?kit=agent-chat`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/u);
  assert.match(await page.text(), /<html|<!doctype html/iu);
} finally {
  await host.stop();
}

async function findRepositoryRoot(configured, start) {
  if (configured) return path.resolve(configured);
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, 'scripts', 'lib', 'web-host-runner.mjs'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error('Cannot locate the Harbors Web Host toolchain');
      current = parent;
    }
  }
}

async function fetchUntilReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent Chat page did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
