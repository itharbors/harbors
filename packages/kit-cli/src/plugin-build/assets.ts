import fs from 'node:fs';
import path from 'node:path';

import { copyDirectoryContents, copyFileIfExists } from './fs.js';
import type { PluginProject } from './types.js';

export function copyPanelAssets(plugin: Pick<PluginProject, 'panels'>): void {
  for (const panel of plugin.panels) {
    copyFileIfExists(
      path.join(panel.sourceDir, 'index.html'),
      path.join(panel.distDir, 'index.html'),
    );
    copyDirectoryContents(
      panel.sourceDir,
      panel.distDir,
      new Set(['index.ts', 'index.css', 'index.html']),
      new Set(['.ts', '.tsx']),
    );
  }
}

export function copyPreparedMainAssets(plugin: Pick<PluginProject, 'rootDir' | 'main'>): void {
  if (!plugin.main) return;
  const preparedAssets = path.join(plugin.rootDir, 'main', '.build');
  if (!fs.existsSync(preparedAssets)) return;
  copyDirectoryContents(preparedAssets, plugin.main.distDir);
}
