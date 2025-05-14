import { instance as Window } from './window';
import { instance as Plugin } from './plugin';
import { instance as Kit } from './kit';

export { instance as Window } from './window';
export { instance as Plugin } from './plugin';
export { instance as Kit } from './kit';

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
