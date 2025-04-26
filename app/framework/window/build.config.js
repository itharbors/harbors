exports.tsc = function() {
    return [
        './module',
        './panel',
        './panel-preload',
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
