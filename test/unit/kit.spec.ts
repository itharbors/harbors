import '../setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Kit } from '../../app/source/framework/kit/kit.js';
import { instance as Plugin } from '../../app/source/framework/plugin/index.js';
import { cleanupTemp, createTempKit } from '../utils.js';

describe('Kit', () => {
    
    beforeEach(() => {
        Plugin.execture('reset');
    });
    
    afterEach(() => {
        cleanupTemp();
    });

  describe('基本功能', () => {
    it('能正确加载套件配置', () => {
      const kit = createTempKit();
      
      const kitInstance = new Kit(kit.dir);
      
      assert.equal(kitInstance.name, kit.name);
      assert.equal(kitInstance.window.width, 800);
      assert.equal(kitInstance.window.height, 600);
    });
    
    it('init 能加载插件', async () => {
      const kit = createTempKit({ plugins: ['plugin1', 'plugin2'] });
      
      const kitInstance = new Kit(kit.dir);
      await kitInstance.init();
      
      const infos1 = await Plugin.execture('queryInfos', { name: 'plugin1' });
      const infos2 = await Plugin.execture('queryInfos', { name: 'plugin2' });
      
      assert.equal(infos1.length, 1);
      assert.equal(infos2.length, 1);
    });
  });
});
