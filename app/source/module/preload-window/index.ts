/**
 * 向渲染进程暴露安全的 API
 */
import { join } from 'path';

import { registerPreload } from '@itharbors/electron-panel/renderer';
import '../layout/index';

// import * as message from './message';

registerPreload(join(__dirname, '../preload-panel/index.js'));
