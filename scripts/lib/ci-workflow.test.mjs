import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/ci.yaml', rootUrl);
const packageUrl = new URL('package.json', rootUrl);
const packageLockUrl = new URL('package-lock.json', rootUrl);

test('CI installs locked dependencies before running the repository check', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const installIndex = workflow.indexOf('run: npm ci');
  const checkIndex = workflow.indexOf('run: npm run check');

  assert.notEqual(installIndex, -1, 'CI must install dependencies with npm ci');
  assert.notEqual(checkIndex, -1, 'CI must run the repository check script');
  assert.ok(installIndex < checkIndex, 'CI must install dependencies before checking');
});

test('CI only invokes npm scripts declared by the root package', async () => {
  const [workflow, packageText] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(packageUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const invokedScripts = [...workflow.matchAll(/run:\s+npm run ([\w:-]+)/g)].map(
    ([, script]) => script,
  );

  assert.ok(invokedScripts.length > 0, 'CI must invoke at least one npm script');
  for (const script of invokedScripts) {
    assert.ok(
      Object.hasOwn(packageJson.scripts ?? {}, script),
      `CI invokes missing root npm script: ${script}`,
    );
  }
});

test('CI dependency lock does not reference the private npm registry', async () => {
  const packageLock = await readFile(packageLockUrl, 'utf8');

  assert.equal(
    packageLock.includes('https://bnpm.byted.org/'),
    false,
    'package-lock.json must use a registry reachable by public GitHub runners',
  );
});

test('CI runs for every pull request change without repository-inaccurate path filters', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const triggers = parseWorkflowTriggers(workflow);

  assert.ok(triggers.has('pull_request'), 'CI must declare a pull_request trigger');
  assert.equal(
    triggers.get('pull_request').has('paths'),
    false,
    'pull_request CI must not skip changes outside an incomplete path allowlist',
  );
});

function parseWorkflowTriggers(workflow) {
  const lines = workflow.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => line === 'on:');
  assert.notEqual(onIndex, -1, 'workflow must contain a top-level on mapping');
  const triggers = new Map();
  let currentTrigger = null;
  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line)) break;
    const trigger = line.match(/^  ([\w-]+):/);
    if (trigger) {
      currentTrigger = trigger[1];
      triggers.set(currentTrigger, new Set());
      continue;
    }
    const property = line.match(/^    ([\w-]+):/);
    if (property && currentTrigger) triggers.get(currentTrigger).add(property[1]);
  }
  return triggers;
}
