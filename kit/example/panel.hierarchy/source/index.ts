import { readFileSync } from 'fs';
import { join } from 'path';
debugger
const instance = Editor.Module.registerPanel({
    html: readFileSync(join(__dirname, '../template.html'), 'utf-8'),

    data() {
        return {
            num: 0,
        };
    },

    load() {
        Editor.Message
            .request('default-example', 'query-tabs')
            .then((tabs: string[]) => {
                const $buttons = document.querySelector('.buttons');

                tabs.forEach((tab) => {
                    const $div = document.createElement('div');
                    const $span = document.createElement('span');
                    $div.setAttribute('id', tab);
                    $span.innerHTML = tab;
                    $div.appendChild($span);
                    $div.addEventListener('click', () => {
                        Editor.Message.request('default-example', 'change-tab', tab);
                    });
                    $buttons?.appendChild($div);
                });
            })
            .catch((error) => {
                console.error(error);
            });

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
            document.querySelector('.buttons > div[active]')?.removeAttribute('active');

            const $elem = document.getElementById(tab);
            $elem && $elem.setAttribute('active', '');
        },
    },
});

exports.default = instance;
