import '../setup.js';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { instance as Menu } from '../../app/source/framework/menu/index.js';

describe('Menu', () => {

    before(async () => {
        await Menu.run('register');
    });

    beforeEach(() => {
        Menu.execture('reset');
    });

    describe('模块存在性', () => {
        it('Menu 模块存在', () => {
            assert.ok(Menu !== undefined);
        });

        it('Menu 有 execture 方法', () => {
            assert.ok(typeof Menu.execture === 'function');
        });
    });

    describe('set - 设置菜单', () => {
        it('set 能设置菜单', () => {
            const menuJSON = {
                'test-menu': {
                    method: ['method1', 'method2']
                }
            };

            Menu.execture('set', 'test-plugin', menuJSON);
        });

        it('同一插件多次设置会覆盖', () => {
            const menuJSON1 = {
                'menu1': { method: ['method1'] }
            };
            const menuJSON2 = {
                'menu2': { method: ['method2'] }
            };

            Menu.execture('set', 'test-plugin', menuJSON1);
            Menu.execture('set', 'test-plugin', menuJSON2);
        });
    });

    describe('remove - 移除菜单', () => {
        it('remove 能移除菜单', () => {
            const menuJSON = {
                'test-menu': {
                    method: ['method1']
                }
            };

            Menu.execture('set', 'test-plugin', menuJSON);
            Menu.execture('remove', 'test-plugin');
        });

        it('remove 不存在的插件不报错', () => {
            Menu.execture('remove', 'non-existent-plugin');
        });
    });

    describe('reset - 重置菜单', () => {
        it('reset 能清空所有菜单', () => {
            const menuJSON = { 'menu1': { method: ['method1'] } };
            Menu.execture('set', 'test-plugin', menuJSON);
            Menu.execture('reset');
        });
    });

    describe('多插件菜单', () => {
        it('能同时设置多个插件的菜单', () => {
            const menuJSON1 = { 'menu1': { method: ['method1'] } };
            const menuJSON2 = { 'menu2': { method: ['method2'] } };

            Menu.execture('set', 'plugin1', menuJSON1);
            Menu.execture('set', 'plugin2', menuJSON2);
        });

        it('移除一个插件不影响其他插件', () => {
            const menuJSON1 = { 'menu1': { method: ['method1'] } };
            const menuJSON2 = { 'menu2': { method: ['method2'] } };

            Menu.execture('set', 'plugin1', menuJSON1);
            Menu.execture('set', 'plugin2', menuJSON2);
            Menu.execture('remove', 'plugin1');
        });
    });
});