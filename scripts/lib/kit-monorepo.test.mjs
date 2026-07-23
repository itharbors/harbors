import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFICIAL_KIT_SLUGS,
  loadOfficialKit,
  loadKitPolicy,
} from './kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('loads the exact official Kit set from one strict policy', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  assert.deepEqual(OFFICIAL_KIT_SLUGS, ['mysql', 'notifications', 'sqlite']);
  assert.equal(policy.repository, 'itharbors/harbors');
  assert.deepEqual(policy.signerWorkflows, [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ]);
});

test('rejects unknown Kit slugs before resolving a path', async () => {
  await assert.rejects(
    loadOfficialKit({ repositoryRoot, slug: '../sqlite' }),
    /unknown official Kit slug/i,
  );
});
