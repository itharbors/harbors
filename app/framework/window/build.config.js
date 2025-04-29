exports.tsc = function() {
    return [
        './module',
        './panel',
        './panel-preload',
        './preload',
        './layout',
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

exports.dts = function() {
    return [];
};
