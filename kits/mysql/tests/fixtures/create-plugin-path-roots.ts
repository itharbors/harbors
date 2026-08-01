import path from 'node:path';
import type { PluginPathRoots } from '../../../../packages/server/src/framework/plugin/paths';

export function createPluginPathRoots(applicationData: string): PluginPathRoots {
  return {
    applicationData,
    data: path.join(applicationData, 'plugins', 'data'),
    cache: path.join(applicationData, 'plugins', 'cache'),
    temp: path.join(applicationData, 'plugins', 'temp'),
  };
}
