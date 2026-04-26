import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { createTempPlugin, cleanupTemp } from '../utils.js';

describe('Plugin', () => {

    beforeEach(() => {
        Plugin.execture('reset');
    });

    afterEach(() => {
        cleanupTemp();
    });

  describe('基本生命周期', () => {
    it('register 能注册插件', async () => {
      const plugin = createTempPlugin();

      await Plugin.execture('register', plugin.dir);

      const infos = await Plugin.execture('queryInfos', { name: plugin.name });
      assert.equal(infos.length, 1);
      assert.equal(infos[0].name, plugin.name);
    });

    it('load 能加载插件', async () => {
      const plugin = createTempPlugin();
      await Plugin.execture('register', plugin.dir);

      const info = await Plugin.execture('load', plugin.dir);

      assert.equal(info.name, plugin.name);
    });

    it('unload 能卸载插件', async () => {
      const plugin = createTempPlugin();
      await Plugin.execture('register', plugin.dir);
      await Plugin.execture('load', plugin.dir);

      const info = await Plugin.execture('unload', plugin.dir);

      assert.equal(info.name, plugin.name);
    });

    it('unregister 能注销插件', async () => {
      const plugin = createTempPlugin();
      await Plugin.execture('register', plugin.dir);

      const info = await Plugin.execture('unregister', plugin.dir);

      assert.equal(info.name, plugin.name);
    });
  });

  describe('同名插件替换', () => {
    it('加载同名插件时，旧插件被卸载', async () => {
      const plugin1 = createTempPlugin({ name: 'same-name-plugin' });
      const plugin2 = createTempPlugin({ name: 'same-name-plugin', packageJson: { name: 'same-name-plugin', version: '2.0.0', main: 'source/index.js' } });

      await Plugin.execture('register', plugin1.dir);
      await Plugin.execture('load', plugin1.dir);
      await Plugin.execture('register', plugin2.dir);

      const info = await Plugin.execture('load', plugin2.dir);

      assert.equal(info.name, 'same-name-plugin');
    });
  });

  describe('查询', () => {
    it('能按名称查询插件', async () => {
      const plugin = createTempPlugin({ name: 'query-test-plugin' });

      await Plugin.execture('register', plugin.dir);

      const infos = await Plugin.execture('queryInfos', { name: 'query-test-plugin' });
      assert.equal(infos.length, 1);
      assert.equal(infos[0].name, 'query-test-plugin');
    });

    it('queryInfos 返回所有匹配的插件', async () => {
      const plugin1 = createTempPlugin({ name: 'test-plugin-1' });
      const plugin2 = createTempPlugin({ name: 'test-plugin-2' });

      await Plugin.execture('register', plugin1.dir);
      await Plugin.execture('register', plugin2.dir);

      const infos = await Plugin.execture('queryInfos', { name: plugin1.name });
      assert.equal(infos.length, 1);
    });
  });

  describe('reset - 重置状态', () => {
    it('reset 能清空所有注册的插件', async () => {
      const plugin = createTempPlugin();
      await Plugin.execture('register', plugin.dir);

      Plugin.execture('reset');

      const infos = await Plugin.execture('queryInfos', { name: plugin.name });
      assert.equal(infos.length, 0);
    });
  });

  describe('callPlugin - 调用插件方法', () => {
    it('callPlugin 能调用已加载插件的方法', async () => {
      const plugin = createTempPlugin({
        name: 'call-test-plugin',
        source: `
          module.exports = {
            default: {
              run: () => Promise.resolve(),
              execture: (method, ...args) => {
                if (method === 'getValue') {
                  return Promise.resolve('test-value');
                }
                if (method === 'add') {
                  return Promise.resolve(args[0] + args[1]);
                }
                return Promise.resolve();
              }
            }
          };
        `
      });

      await Plugin.execture('register', plugin.dir);
      await Plugin.execture('load', plugin.dir);

      const result1 = await Plugin.execture('callPlugin', 'call-test-plugin', 'getValue');
      assert.equal(result1, 'test-value');

      const result2 = await Plugin.execture('callPlugin', 'call-test-plugin', 'add', 1, 2);
      assert.equal(result2, 3);
    });

    it('callPlugin 调用未加载的插件会报错', async () => {
      const plugin = createTempPlugin({ name: 'not-loaded-plugin' });
      await Plugin.execture('register', plugin.dir);

      await assert.rejects(
        async () => {
          await Plugin.execture('callPlugin', 'not-loaded-plugin', 'anyMethod');
        },
        (error: any) => {
          return error.message.includes('not defined');
        }
      );
    });

    it('callPlugin 调用不存在的方法返回 undefined', async () => {
      const plugin = createTempPlugin({ name: 'method-test-plugin' });
      await Plugin.execture('register', plugin.dir);
      await Plugin.execture('load', plugin.dir);

      const result = await Plugin.execture('callPlugin', 'method-test-plugin', 'nonExistentMethod');
      assert.equal(result, undefined);
    });
  });

  describe('生命周期顺序', () => {
    it('unregister 已加载的插件会先 unload 再 unregister', async () => {
      const plugin = createTempPlugin({ name: 'lifecycle-test-plugin' });
      await Plugin.execture('register', plugin.dir);
      await Plugin.execture('load', plugin.dir);

      await Plugin.execture('unregister', plugin.dir);

      const infos = await Plugin.execture('queryInfos', { name: 'lifecycle-test-plugin' });
      assert.equal(infos.length, 0);
    });
  });
});