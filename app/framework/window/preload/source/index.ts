/**
 * 向渲染进程暴露安全的 API
 */
import { convertURL } from '../../panel';

import '../../layout/dist/index';

import * as message from './message';

convertURL(async (name: string) => {
    const path = await message.request('panel', 'query-path', name);
    return path || name;
});
