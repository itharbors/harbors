import path from 'node:path';

import { copyFileIfExists } from './fs.js';
import type { PluginProject } from './types.js';

export function copyPanelStyles(plugin: Pick<PluginProject, 'panels'>): void {
  for (const panel of plugin.panels) {
    copyFileIfExists(
      path.join(panel.sourceDir, 'index.css'),
      path.join(panel.distDir, 'index.css'),
    );
  }
}
