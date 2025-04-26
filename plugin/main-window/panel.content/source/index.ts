// 在 html 里引入的 mermaid 库
declare const mermaid: any;

const instance = Editor.Panel.register({
    stash() {
        return {};
    },
    data() {
        return {};
    },

    async load() {},

    method: {
        'change-mermaid'(data) {
            const $elem = document.querySelector('#container');
            if ($elem) {
                $elem.innerHTML = `<pre class="mermaid">${data}</pre>`;
            }

            mermaid.run({
                nodes: document.querySelectorAll('.mermaid')
            });
        },
    },
});

Editor.Message
    .request('main-window', 'query-mermaid')
    .then((mermaid) => {
        instance.execture('change-mermaid', mermaid);
    })
    .catch((error) => {
        console.error(error);
    });
