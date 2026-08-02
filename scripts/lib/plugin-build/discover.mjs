import {
  discoverAllPlugins as discoverAllPluginsInRepository,
  discoverPlugin,
  discoverRuntimePlugins as discoverRuntimePluginsInRepository,
} from '@itharbors/kit-cli';

import { discoverRepositoryKits } from '../repository-kits.mjs';

export { discoverPlugin };

export function discoverAllPlugins(repoRoot) {
  return discoverAllPluginsInRepository(repoRoot);
}

export async function discoverRuntimePlugins(repoRoot) {
  const descriptors = await discoverRepositoryKits({ repositoryRoot: repoRoot });
  return discoverRuntimePluginsInRepository(repoRoot, descriptors);
}
