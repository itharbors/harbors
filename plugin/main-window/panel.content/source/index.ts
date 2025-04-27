// 在 html 里引入的 mermaid 库
declare const mermaid: any;

const instance = Editor.Module.register({
    stash() {
        return {};
    },
    data() {
        return {};
    },

    async load() {},

    method: {
        changeTab() {
            Editor.Message
                .request('main-window', 'query-mermaid')
                .then((data) => {
                    const $elem = document.querySelector('#container');
                    if ($elem) {
                        $elem.innerHTML = `<pre class="mermaid">${data}</pre>`;
                    }

                    mermaid.run({
                        nodes: document.querySelectorAll('.mermaid')
                    });
                })
                .catch((error) => {
                    console.error(error);
                });
        },
    },
});

instance.execture('changeTab');
