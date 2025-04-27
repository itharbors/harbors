
const instance = Editor.Module.register({
    stash() {
        return {};
    },
    data() {
        return {};
    },

    async load() {},

    method: {
        'change-tab'(tab: string) {
            document.querySelector('.buttons > div[active]')?.removeAttribute('active');

            const $elem = document.getElementById(tab);
            $elem && $elem.setAttribute('active', '');
        },
    },
});

Editor.Message
    .request('main-window', 'query-tab')
    .then((tab) => {
        instance.execture('change-tab', tab);
    })
    .catch((error) => {
        console.error(error);
    });


document.querySelectorAll('.buttons > div').forEach((elem) => {
    elem.addEventListener('click', () => {
        const tab = elem.getAttribute('id');
        Editor.Message.request('main-window', 'change-tab', tab);
    });
});