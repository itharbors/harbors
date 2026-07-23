import path from 'node:path';
import { copyDirectoryContents, copyFileIfExists } from './fs.mjs';

export function copyPanelAssets(plugin) {
  for (const panel of plugin.panels) {
    copyFileIfExists(path.join(panel.sourceDir, 'index.html'), path.join(panel.distDir, 'index.html'));
    copyDirectoryContents(panel.sourceDir, panel.distDir, new Set(['index.ts', 'index.css', 'index.html']));
  }
}
