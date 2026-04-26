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
  });
});
