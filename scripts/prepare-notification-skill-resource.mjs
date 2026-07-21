import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareCodexSkillResource } from './lib/codex-skill-resource.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = path.join(rootDir, '.agents', 'skills', 'notify-user');
const destinationDir = path.join(
  rootDir,
  'kits',
  'notifications',
  'plugins',
  'notification-center',
  'main',
  'dist',
  'resources',
  'notify-user',
);

await prepareCodexSkillResource({ sourceDir, destinationDir });
