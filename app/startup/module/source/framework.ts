import { instance as window } from '../../../framework/window';
import { instance as plugin } from '../../../framework/plugin';
import { instance as kit } from '../../../framework/kit';
import { instance as profile } from '../../../framework/profile';

export { instance as window } from '../../../framework/window';
export { instance as plugin } from '../../../framework/plugin';
export { instance as kit } from '../../../framework/kit';
export { instance as profile } from '../../../framework/profile';

export async function runModuleLifeCycle(lifecycle: 'register' | 'load') {
    await plugin.run(lifecycle);
    await window.run(lifecycle);
    await kit.run(lifecycle);
    await profile.run(lifecycle);
}
