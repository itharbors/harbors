import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const kitDirectory = process.cwd();
const repositoryRoot = await findRepositoryRoot(process.env.HARBORS_REPOSITORY_ROOT, kitDirectory);
const runnerUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'lib', 'web-host-runner.mjs')).href;
const { startWebHost } = await import(runnerUrl);

const host = await startWebHost({
  repositoryRoot,
  kitSources: [{ directory: kitDirectory, source: 'explicit' }],
  defaultKit: 'harness',
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
  assert.ok(kits.some((kit) => kit?.id === 'harness' && kit?.name === 'harness' && kit?.label === 'Harbors Harness'));

  const publicPath = await fetch(`${host.baseUrl}/kits/harness`, { redirect: 'manual' });
  assert.equal(publicPath.status, 302);
  assert.equal(publicPath.headers.get('location'), '/?kit=harness');

  const page = await fetchUntilReady(`${host.baseUrl}/?kit=harness`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/u);
  const html = await page.text();
  assert.match(html, /<html|<!doctype html/iu);

  const mainEntry = await readFile(path.join(kitDirectory, 'main.html'), 'utf8');
  const secondaryEntry = await readFile(path.join(kitDirectory, 'secondary.html'), 'utf8');
  assert.match(mainEntry, /<title>Harbors Harness<\/title>/u);
  assert.match(secondaryEntry, /<title>Harbors Harness Window<\/title>/u);

  const legacyPath = await fetch(`${host.baseUrl}/kits/agent-chat`, { redirect: 'manual' });
  assert.equal(legacyPath.status, 404);
  assert.equal(legacyPath.headers.get('location'), null);

  const smokeUserResponse = await fetch(`${host.baseUrl}/api/workbench/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Harness Smoke' }),
  });
  assert.equal(smokeUserResponse.status, 201);
  const smokeUser = await smokeUserResponse.json();
  const smokeSessionResponse = await fetch(`${host.baseUrl}/api/workbench/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: smokeUser.userId }),
  });
  assert.equal(smokeSessionResponse.status, 201);
  const smokeSession = await smokeSessionResponse.json();

  const legacySessionInitialization = await fetch(`${host.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: smokeSession.sessionId, kit: 'agent-chat' }),
  });
  assert.equal(legacySessionInitialization.status, 404);
  assert.deepEqual(await legacySessionInitialization.json(), {
    error: { code: 'KIT_NOT_FOUND', message: 'Kit "agent-chat" not found', details: null },
  });
  const existingSessionLookup = await fetch(`${host.baseUrl}/api/session/${smokeSession.sessionId}`);
  assert.equal(existingSessionLookup.status, 200);
  assert.equal((await existingSessionLookup.json()).sessionId, smokeSession.sessionId);
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
  throw new Error(`Harbors Harness page did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
