// 在 html 里引入的 marked 库
declare const marked: any;

const instance = Editor.Module.registerPanel({
    stash() {
        return {};
    },
    data() {
        return {};
    },

    async load() {
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

export default instance;
