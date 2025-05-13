/**
 * 插件里的 package.json 信息
 */
export type TPluginJSON = {
    // 插件名称
    name: string;

    // 插件主要逻辑文件
    main?: string;

    // 附加数据
    extra?: Record<string, any>;

    // 贡献数据
    contribute?: Record<string, any>;
};

/**
 * 插件在管理器内存储的对象信息
 */
export type TPluginInfo = {
    name: string;
    path: string;
    json: TPluginJSON;
};
