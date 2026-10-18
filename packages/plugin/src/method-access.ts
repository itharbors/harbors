import type { PluginInfo, PluginMessageRoute } from './types.js';

/** Uses the same public request declarations as message dispatch. */
export function assertPluginMethodAccess(callerPlugin: string, target: PluginInfo, method: string): void {
  const permitted = callerPlugin.length > 0 && !method.startsWith('panel.')
    && Object.entries(target.contribute?.message?.request ?? {}).some(([name, declaration]) => {
      if (name === '*') return false;
      const route: PluginMessageRoute = Array.isArray(declaration)
        ? { methods: declaration }
        : declaration as PluginMessageRoute;
      // Message dispatch sends a route containing panel methods to the panel.
      return !route.methods.some((candidate) => candidate.startsWith('panel.'))
        && route.methods.includes(method)
        && (route.callers === undefined || route.callers.includes(callerPlugin));
    });
  if (!permitted) {
    throw new Error(`Plugin method "${target.name}.${method}" is not permitted for caller "${callerPlugin}"`);
  }
}
