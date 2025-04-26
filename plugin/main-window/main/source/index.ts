exports.method = {
    'query-env'() {
        return {
            Electron: process.versions.electron,
            NodeJS: process.versions.node,
            Chromium: process.versions.chrome,
        };
    },
};
