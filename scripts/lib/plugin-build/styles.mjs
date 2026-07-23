import path from 'node:path';
import { copyFileIfExists } from './fs.mjs';

export function copyPanelStyles(plugin) {
  for (const panel of plugin.panels) {
    copyFileIfExists(path.join(panel.sourceDir, 'index.css'), path.join(panel.distDir, 'index.css'));
  }
}
