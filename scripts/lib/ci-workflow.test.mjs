import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/ci.yaml', rootUrl);
const packageUrl = new URL('package.json', rootUrl);

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
