import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempPlugin, cleanupTemp } from '../utils.js';

describe('Panel Plugin', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('基本生命周期', () => {
        it('panel 插件能正确注册和加载', async () => {
            const panelPlugin = createTempPlugin({
                name: 'panel',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', panelPlugin.dir);
            const info = await Plugin.execture('load', panelPlugin.dir);
            assert.equal(info.name, 'panel');
        });

        it('panel 插件能正常卸载', async () => {
            const panelPlugin = createTempPlugin({
                name: 'panel',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', panelPlugin.dir);
            await Plugin.execture('load', panelPlugin.dir);
            
            const info = await Plugin.execture('unload', panelPlugin.dir);
            assert.equal(info.name, 'panel');
        });

        it('panel 插件能正常注销', async () => {
            const panelPlugin = createTempPlugin({
                name: 'panel',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', panelPlugin.dir);
            await Plugin.execture('load', panelPlugin.dir);
            
            const info = await Plugin.execture('unregister', panelPlugin.dir);
            assert.equal(info.name, 'panel');
        });
    });

    describe('边界情况', () => {
        it('重复注册 panel 插件不会报错', async () => {
            const panelPlugin = createTempPlugin({
                name: 'panel',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', panelPlugin.dir);
            await Plugin.execture('register', panelPlugin.dir);
            
            const info = await Plugin.execture('load', panelPlugin.dir);
            assert.equal(info.name, 'panel');
        });

        it('卸载未加载的 panel 插件不会报错', async () => {
            const panelPlugin = createTempPlugin({
                name: 'panel',
                source: `
                    module.exports = {
                        default: {
                            run: () => Promise.resolve(),
                            execture: () => Promise.resolve()
                        }
                    };
                `
            });

            await Plugin.execture('register', panelPlugin.dir);
            
            const info = await Plugin.execture('unload', panelPlugin.dir);
            assert.equal(info.name, 'panel');
        });
    });
});