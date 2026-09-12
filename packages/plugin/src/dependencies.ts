export const PLUGIN_DEPENDENCY_ERROR_CODES = [
  'PLUGIN_DEPENDENCY_MISSING',
  'PLUGIN_DEPENDENCY_CYCLE',
  'PLUGIN_DEPENDENCY_INVALID',
  'PLUGIN_NOT_RUNNING',
  'PLUGIN_METHOD_NOT_FOUND',
  'PLUGIN_DEPENDENTS_RUNNING',
] as const;

export type PluginDependencyErrorCode = typeof PLUGIN_DEPENDENCY_ERROR_CODES[number];

export class PluginDependencyError extends Error {
  readonly code: PluginDependencyErrorCode;
  readonly plugin: string;
  readonly dependency?: string;

  constructor(
    code: PluginDependencyErrorCode,
    message: string,
    details: { plugin: string; dependency?: string },
  ) {
    super(message);
    this.name = 'PluginDependencyError';
    this.code = code;
    this.plugin = details.plugin;
    this.dependency = details.dependency;
  }
}

export interface PluginDependencyNode {
  readonly name: string;
  readonly requires?: Readonly<{ plugins: readonly string[] }>;
}

/** Resolve a stable dependency order without executing or mutating any Plugin. */
export function resolvePluginLoadOrder<T extends PluginDependencyNode>(
  plugins: readonly T[],
  availablePluginNames: readonly string[] = [],
): T[] {
  const byName = new Map<string, T>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new PluginDependencyError(
        'PLUGIN_DEPENDENCY_INVALID',
        `Plugin "${plugin.name}" is declared more than once`,
        { plugin: plugin.name },
      );
    }
    byName.set(plugin.name, plugin);
  }

  const available = new Set(availablePluginNames);
  for (const plugin of plugins) {
    for (const dependency of plugin.requires?.plugins ?? []) {
      if (dependency === plugin.name) {
        throw new PluginDependencyError(
          'PLUGIN_DEPENDENCY_INVALID',
          `Plugin "${plugin.name}" must not depend on itself`,
          { plugin: plugin.name, dependency },
        );
      }
      if (!byName.has(dependency) && !available.has(dependency)) {
        throw new PluginDependencyError(
          'PLUGIN_DEPENDENCY_MISSING',
          `Plugin "${plugin.name}" requires missing Plugin "${dependency}"`,
          { plugin: plugin.name, dependency },
        );
      }
    }
  }

  const ordered: T[] = [];
  const resolved = new Set(available);
  const pending = [...plugins];
  while (pending.length > 0) {
    const index = pending.findIndex((plugin) => (
      (plugin.requires?.plugins ?? []).every((dependency) => resolved.has(dependency))
    ));
    if (index < 0) {
      const plugin = pending[0]!;
      const dependency = (plugin.requires?.plugins ?? []).find((name) => !resolved.has(name));
      throw new PluginDependencyError(
        'PLUGIN_DEPENDENCY_CYCLE',
        `Plugin dependency graph contains a cycle involving "${plugin.name}"`,
        { plugin: plugin.name, ...(dependency ? { dependency } : {}) },
      );
    }
    const [plugin] = pending.splice(index, 1);
    ordered.push(plugin!);
    resolved.add(plugin!.name);
  }
  return ordered;
}
