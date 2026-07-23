import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareCodexSkillResource } from './lib/codex-skill-resource.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
await prepareCodexSkillResource({
  sourceDir: path.join(rootDir, '.agents', 'skills', 'notify-user'),
  destinationDir: path.join(rootDir, 'plugins', 'notification-background', 'main', 'dist', 'resources', 'notify-user'),
});
