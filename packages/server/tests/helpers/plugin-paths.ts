import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginPathRoots } from '../../src/framework/plugin/paths';

export function createTestPluginPathRoots(
  applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-test-plugin-paths-')),
): PluginPathRoots {
  return Object.freeze({
    applicationData,
    data: path.join(applicationData, 'plugins', 'data'),
    cache: path.join(applicationData, 'plugins', 'cache'),
    temp: path.join(applicationData, 'plugins', 'temp'),
  });
}
