import '../setup.js';
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Kit } from '../../app/source/framework/kit/index.js';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempKit, cleanupTemp } from '../utils.js';

describe('Kit', () => {

    before(async () => {
        Plugin.execture('reset');
        await Kit.run('register');
    });

    afterEach(() => {
        cleanupTemp();
    });

    describe('load - 加载套件', () => {
        it('load 能加载套件', async () => {
            const kit = createTempKit({ name: 'test-kit' });
            await Kit.execture('load', kit.dir);
        });

        it('load 同一套件两次会覆盖', async () => {
            const kit1 = createTempKit({ name: 'same-kit', plugins: ['plugin1'] });
            const kit2 = createTempKit({ name: 'same-kit', plugins: ['plugin2'] });

            await Kit.execture('load', kit1.dir);
            await Kit.execture('load', kit2.dir);
        });
    });

    describe('unload - 卸载套件', () => {
        it('unload 能卸载套件', async () => {
            const kit = createTempKit();
            await Kit.execture('load', kit.dir);
            await Kit.execture('unload', kit.dir);
        });

        it('unload 不存在的套件不报错', async () => {
            await Kit.execture('unload', '/non/existent/path');
        });
    });

    describe('getLayout - 获取布局', () => {
        it('getLayout 不存在的套件返回 undefined', async () => {
            const layout = await Kit.execture('getLayout', 'non-existent');
            assert.equal(layout, undefined);
        });
    });

    describe('getWindow - 获取窗口配置', () => {
        it('getWindow 能获取窗口配置', async () => {
            const kit = createTempKit({ name: 'test-kit' });
            await Kit.execture('load', kit.dir);

            const window = await Kit.execture('getWindow', 'test-kit');
            assert.ok(window !== undefined);
            assert.equal(window.width, 800);
            assert.equal(window.height, 600);
        });

        it('getWindow 不存在的套件返回 undefined', async () => {
            const window = await Kit.execture('getWindow', 'non-existent');
            assert.equal(window, undefined);
        });
    });
});