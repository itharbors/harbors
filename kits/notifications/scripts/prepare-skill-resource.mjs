import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareResource } from './lib/prepare-resource.mjs';

const kitDirectory = fileURLToPath(new URL('..', import.meta.url));

await prepareResource({
  sourceDir: path.join(kitDirectory, 'resources', 'notify-user'),
  destinationDir: path.join(
    kitDirectory,
    'plugins',
    'notification-background',
    'main',
    '.build',
    'resources',
    'notify-user',
  ),
});
