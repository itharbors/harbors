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

const instance = Editor.Module.registerPanel({
    stash() {
        return {};
    },
    data() {
        return {};
    },
    method: {},
});
