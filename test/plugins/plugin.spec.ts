import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempPlugin, cleanupTemp } from '../utils.js';

describe('Plugin Method', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('callPlugin - 调用插件方法', () => {
        it('callPlugin 能调用已加载插件的自定义方法', async () => {
            const plugin = createTempPlugin({
                name: 'method-plugin',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: (method, ...args) => {
                                if (method === 'getGreeting') {
                                    return Promise.resolve('Hello from plugin');
                                }
                                if (method === 'addNumbers') {
                                    return Promise.resolve(args[0] + args[1]);
                                }
                                if (method === 'getPluginInfo') {
                                    return Promise.resolve({ name: 'method-plugin', version: '1.0.0' });
                                }
                                return Promise.resolve();
                            }
                        }
                    };
                `
            });

            await Plugin.execture('register', plugin.dir);
            await Plugin.execture('load', plugin.dir);

            const greeting = await Plugin.execture('callPlugin', 'method-plugin', 'getGreeting');
            assert.equal(greeting, 'Hello from plugin');

            const sum = await Plugin.execture('callPlugin', 'method-plugin', 'addNumbers', 10, 20);
            assert.equal(sum, 30);

            const info = await Plugin.execture('callPlugin', 'method-plugin', 'getPluginInfo');
            assert.deepEqual(info, { name: 'method-plugin', version: '1.0.0' });
        });

        it('callPlugin 调用不存在的方法返回 undefined', async () => {
            const plugin = createTempPlugin({
                name: 'no-method-plugin',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', plugin.dir);
            await Plugin.execture('load', plugin.dir);

            const result = await Plugin.execture('callPlugin', 'no-method-plugin', 'nonExistentMethod');
            assert.equal(result, undefined);
        });

        it('callPlugin 调用未加载的插件会报错', async () => {
            const plugin = createTempPlugin({ name: 'not-loaded-method-plugin' });
            await Plugin.execture('register', plugin.dir);

            await assert.rejects(
                async () => {
                    await Plugin.execture('callPlugin', 'not-loaded-method-plugin', 'anyMethod');
                },
                (error: any) => {
                    return error.message.includes('not defined');
                }
            );
        });
    });
});

describe('Plugin Lifecycle - 插件生命周期', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('register -> load -> unload -> unregister', () => {
        it('完整生命周期：register -> load -> unload -> unregister', async () => {
            const plugin = createTempPlugin({ name: 'lifecycle-plugin' });

            const info1 = await Plugin.execture('register', plugin.dir);
            assert.equal(info1.name, 'lifecycle-plugin');

            const info2 = await Plugin.execture('load', plugin.dir);
            assert.equal(info2.name, 'lifecycle-plugin');

            const info3 = await Plugin.execture('unload', plugin.dir);
            assert.equal(info3.name, 'lifecycle-plugin');

            const info4 = await Plugin.execture('unregister', plugin.dir);
            assert.equal(info4.name, 'lifecycle-plugin');
        });

        it('unregister 已加载的插件会先自动 unload', async () => {
            const plugin = createTempPlugin({ name: 'auto-unload-plugin' });

            await Plugin.execture('register', plugin.dir);
            await Plugin.execture('load', plugin.dir);

            await Plugin.execture('unregister', plugin.dir);

            const infos = await Plugin.execture('queryInfos', { name: 'auto-unload-plugin' });
            assert.equal(infos.length, 0);
        });
    });

    describe('同名插件替换', () => {
        it('加载同名插件时，旧插件被自动卸载', async () => {
            const plugin1 = createTempPlugin({
                name: 'replace-plugin',
                packageJson: {
                    name: 'replace-plugin',
                    version: '1.0.0',
                    main: 'source/index.js'
                }
            });

            const plugin2 = createTempPlugin({
                name: 'replace-plugin',
                packageJson: {
                    name: 'replace-plugin',
                    version: '2.0.0',
                    main: 'source/index.js'
                }
            });

            await Plugin.execture('register', plugin1.dir);
            await Plugin.execture('load', plugin1.dir);

            await Plugin.execture('register', plugin2.dir);
            const info = await Plugin.execture('load', plugin2.dir);

            assert.equal(info.json.version, '2.0.0');
        });
    });
});