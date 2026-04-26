import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempPlugin, cleanupTemp } from '../utils.js';

describe('Message Plugin', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('基本生命周期', () => {
        it('message 插件能正确注册和加载', async () => {
            const messagePlugin = createTempPlugin({
                name: 'message',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', messagePlugin.dir);
            const info = await Plugin.execture('load', messagePlugin.dir);
            assert.equal(info.name, 'message');
        });

        it('message 插件能正常卸载', async () => {
            const messagePlugin = createTempPlugin({
                name: 'message',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', messagePlugin.dir);
            await Plugin.execture('load', messagePlugin.dir);
            
            const info = await Plugin.execture('unload', messagePlugin.dir);
            assert.equal(info.name, 'message');
        });

        it('message 插件能正常注销', async () => {
            const messagePlugin = createTempPlugin({
                name: 'message',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', messagePlugin.dir);
            await Plugin.execture('load', messagePlugin.dir);
            
            const info = await Plugin.execture('unregister', messagePlugin.dir);
            assert.equal(info.name, 'message');
        });
    });

    describe('边界情况', () => {
        it('重复注册 message 插件不会报错', async () => {
            const messagePlugin = createTempPlugin({
                name: 'message',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', messagePlugin.dir);
            await Plugin.execture('register', messagePlugin.dir);
            
            const info = await Plugin.execture('load', messagePlugin.dir);
            assert.equal(info.name, 'message');
        });

        it('卸载未加载的 message 插件不会报错', async () => {
            const messagePlugin = createTempPlugin({
                name: 'message',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', messagePlugin.dir);
            
            const info = await Plugin.execture('unload', messagePlugin.dir);
            assert.equal(info.name, 'message');
        });
    });
});