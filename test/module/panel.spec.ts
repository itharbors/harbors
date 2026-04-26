import '../setup.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { instance as Panel } from '../../app/source/framework/panel/index.js';

describe('Panel', () => {

    before(async () => {
        await Panel.run('register');
    });

    describe('模块存在性', () => {
        it('Panel 模块存在', () => {
            assert.ok(Panel !== undefined);
        });

        it('Panel 有 execture 方法', () => {
            assert.ok(typeof Panel.execture === 'function');
        });
    });

    describe('register - 注册面板', () => {
        it('register 能注册面板不报错', async () => {
            const panelInfo = {
                name: 'test-panel',
                version: '1.0.0',
                file: 'panel.html'
            };

            await Panel.execture('register', 'test-panel', panelInfo);
        });
    });

    describe('unregister - 卸载面板', () => {
        it('unregister 能卸载面板不报错', async () => {
            const panelInfo = {
                name: 'test-panel',
                version: '1.0.0',
                file: 'panel.html'
            };

            await Panel.execture('register', 'test-panel', panelInfo);
            await Panel.execture('unregister', 'test-panel');
        });
    });
});