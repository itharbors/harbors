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
        Editor.Message
            .request('default-example', 'query-env')
            .then((env) => {
                for (let key in env) {
                    const $elem = document.getElementById(key);
                    $elem && ($elem.innerText = env[key]);
                }
            })
            .catch((error) => {
                console.error(error);
            });
    },

    method: {},
});

exports.default = instance;
