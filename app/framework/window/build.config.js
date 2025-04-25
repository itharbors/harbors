exports.tsc = function() {
    return [
        './module',
        './preload',
    ];
};

exports.npm = function() {
    return [
        // {
        //     message: '',
        //     path: './',
        //     params: ['run', 'build:preload'],
        //     detail: '',
        //     // logFile: '',
        // },
    ];
};
