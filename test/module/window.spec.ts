import '../setup.js';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { instance as Window } from '../../app/source/framework/window/index.js';
import { instance as Kit } from '../../app/source/framework/kit/index.js';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempKit, cleanupTemp } from '../utils.js';

describe('Window', () => {

    before(async () => {
        Plugin.execture('reset');
        await Kit.run('register');
        await Window.run('register');
    });

    beforeEach(() => {
        cleanupTemp();
    });

    describe('模块存在性', () => {
        it('Window 模块存在', () => {
            assert.ok(Window !== undefined);
        });

        it('Window 有 execture 方法', () => {
            assert.ok(typeof Window.execture === 'function');
        });
    });

    describe('open - 打开窗口', () => {
        it('open 能打开窗口', async () => {
            const kit = createTempKit({ name: 'test-kit' });
            await Kit.execture('load', kit.dir);
            await Window.execture('open', kit.name);
        });

        it('open 不传参数时使用默认套件', async () => {
            const kit = createTempKit({ name: 'default' });
            await Kit.execture('load', kit.dir);
            await Window.execture('open');
        });

        it('open 能打开多个窗口', async () => {
            const kit1 = createTempKit({ name: 'kit1' });
            const kit2 = createTempKit({ name: 'kit2' });

            await Kit.execture('load', kit1.dir);
            await Kit.execture('load', kit2.dir);

            await Window.execture('open', kit1.name);
            await Window.execture('open', kit2.name);
        });
    });
});