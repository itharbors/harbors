import { instance as Window } from '../framework/window/module';
import { instance as Plugin } from '../framework/plugin/module';
import { instance as Kit } from '../framework/kit/module';

export { instance as Window } from '../framework/window/module';
export { instance as Plugin } from '../framework/plugin/module';
export { instance as Kit } from '../framework/kit/module';

export async function runModuleLifeCycle(lifecycle: 'register' | 'load') {
    await Plugin.run(lifecycle);
    await Window.run(lifecycle);
    await Kit.run(lifecycle);
}

export const Message = {
    async request(plugin: string, method: string, ...args: any[]) {
        const result = await Plugin.execture('callPlugin', plugin, method, args);
        return result;
    },
    sendToPanel(plugin: string, panel: string, method: string, ...args: any[]) {
        Plugin.execture('callPanel', plugin, panel, method, args);
    },
};
