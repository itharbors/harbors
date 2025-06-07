// 在 html 里引入的 marked 库
declare const marked: any;

import { readFileSync } from 'fs';
import { join } from 'path';

const instance = Editor.Module.registerPanel({
    html: readFileSync(join(__dirname, '../template.html'), 'utf-8'),

    data() {
        return {
            num: 0,
        };
    },

    load() {
        // <script src="plugin://default-example/panel.content/static/marked.min.js"></script>
        const $script = document.createElement('script');
        $script.src = 'plugin://default-example/panel.content/static/marked.min.js';
        document.body.appendChild($script);

        Editor.Message
        .request('default-example', 'query-tab')
        .then((tab: string) => {
            instance.execture('changeTab', tab);
        })
        .catch((error) => {
            console.error(error);
        });
    },

    method: {
        changeTab(tab: string) {
            Editor.Message
                .request('default-example', 'query-content', tab)
                .then((data) => {
                    const $html = marked.parse(data);
                    document.getElementById('container')!.innerHTML = $html;
                })
                .catch((error) => {
                    console.error(error);
                });
        },
    },
});

exports.default = instance;
