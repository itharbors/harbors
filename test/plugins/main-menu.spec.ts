import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempPlugin, cleanupTemp } from '../utils.js';

describe('Main Menu Plugin', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('基本生命周期', () => {
        it('main-menu 插件能正确注册和加载', async () => {
            const mainMenuPlugin = createTempPlugin({
                name: 'main-menu',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', mainMenuPlugin.dir);
            const info = await Plugin.execture('load', mainMenuPlugin.dir);
            assert.equal(info.name, 'main-menu');
        });

        it('main-menu 插件能正常卸载', async () => {
            const mainMenuPlugin = createTempPlugin({
                name: 'main-menu',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', mainMenuPlugin.dir);
            await Plugin.execture('load', mainMenuPlugin.dir);
            
            const info = await Plugin.execture('unload', mainMenuPlugin.dir);
            assert.equal(info.name, 'main-menu');
        });

        it('main-menu 插件能正常注销', async () => {
            const mainMenuPlugin = createTempPlugin({
                name: 'main-menu',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', mainMenuPlugin.dir);
            await Plugin.execture('load', mainMenuPlugin.dir);
            
            const info = await Plugin.execture('unregister', mainMenuPlugin.dir);
            assert.equal(info.name, 'main-menu');
        });
    });

    describe('边界情况', () => {
        it('重复注册 main-menu 插件不会报错', async () => {
            const mainMenuPlugin = createTempPlugin({
                name: 'main-menu',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', mainMenuPlugin.dir);
            await Plugin.execture('register', mainMenuPlugin.dir);
            
            const info = await Plugin.execture('load', mainMenuPlugin.dir);
            assert.equal(info.name, 'main-menu');
        });

        it('卸载未加载的 main-menu 插件不会报错', async () => {
            const mainMenuPlugin = createTempPlugin({
                name: 'main-menu',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', mainMenuPlugin.dir);
            
            const info = await Plugin.execture('unload', mainMenuPlugin.dir);
            assert.equal(info.name, 'main-menu');
        });
    });
});