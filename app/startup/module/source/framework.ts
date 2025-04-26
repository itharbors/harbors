import { instance as Window } from '../../../framework/window';
import { instance as Plugin } from '../../../framework/plugin';
import { instance as Kit } from '../../../framework/kit';
import { instance as Profile } from '../../../framework/profile';

export { instance as Window } from '../../../framework/window';
export { instance as Plugin } from '../../../framework/plugin';
export { instance as Kit } from '../../../framework/kit';
export { instance as Profile } from '../../../framework/profile';

export async function runModuleLifeCycle(lifecycle: 'register' | 'load') {
    await Plugin.run(lifecycle);
    await Window.run(lifecycle);
    await Kit.run(lifecycle);
    await Profile.run(lifecycle);
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
