/**
 * 向渲染进程暴露安全的 API
 */
import { readFileSync } from 'fs';

import { convertURL } from '../../panel';
import { injection, parse } from './layout';

import * as message from './message';

convertURL(async (name: string) => {
    const path = await message.request('panel', 'query-path', name);
    return path || name;
});

// {
//     ver: '1',
//     layout: {
//         type: 'fixed',
//         dir: 'vertical',
//         children: [
//             {
//                 type: 'fixed',
//                 dir: 'none',
//                 size: 60,
//                 panel: 'main-window.header',
//             },
//             {
//                 type: 'variable',
//                 dir: 'horizontal',
//                 children: [
//                     {
//                         type: 'fixed',
//                         dir: 'none',
//                         size: 140,
//                         panel: 'main-window.hierarchy',
//                     },
//                     {
//                         type: 'variable',
//                         dir: 'none',
//                         panel: 'main-window.content',
//                     },
//                 ],
//             }
//         ],
//     },
// }

(async () => {
    const reuslt = await Promise.all([
        message.queryLayout(),
        new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', resolve);
        }),
    ]);
    const layout = JSON.parse(readFileSync(reuslt[0], 'utf8'));
    injection();
    const $elem = parse(layout);
    document.body.appendChild($elem);
})();

