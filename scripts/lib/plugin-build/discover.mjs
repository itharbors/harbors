import {
  discoverAllPlugins as discoverAllPluginsInRepository,
  discoverPlugin,
  discoverRuntimePlugins as discoverRuntimePluginsInRepository,
} from '@itharbors/kit-cli';

import { BUILTIN_KITS } from '../builtin-kits.mjs';

export { discoverPlugin };

export function discoverAllPlugins(repoRoot) {
  return discoverAllPluginsInRepository(repoRoot);
}

export function discoverRuntimePlugins(repoRoot) {
  return discoverRuntimePluginsInRepository(repoRoot, BUILTIN_KITS.map((kit) => kit.slug));
}
