import semver from 'semver';
import type { PluginMessageRoute, PluginMessageRouteDeclaration } from './types.js';
import { PluginDependencyError } from './dependencies.js';

export const PLUGIN_PACKAGE_SCHEMA_VERSION = 1 as const;
export const PLUGIN_CAPABILITIES = ['credentials', 'plugin-lifecycle'] as const;

export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

export interface PluginPanelManifest {
  readonly entry: string;
  readonly title?: string;
  readonly titleKey?: string;
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly multiInstance?: boolean;
}

export interface PluginContributionManifest {
  readonly panel?: Readonly<Record<string, PluginPanelManifest>>;
  readonly menu?: readonly unknown[];
  readonly message?: Readonly<{
    request?: Readonly<Record<string, PluginMessageRouteDeclaration>>;
    broadcast?: Readonly<Record<string, PluginMessageRouteDeclaration>>;
  }>;
  readonly [key: string]: unknown;
}

export interface PluginPackageManifest {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly main: string;
  readonly capabilities: readonly PluginCapability[];
  readonly assets: Readonly<{ public: readonly string[] }>;
  readonly requires: Readonly<{ plugins: readonly string[] }>;
  readonly contribute: PluginContributionManifest;
}

type UnknownRecord = Record<string, unknown>;

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function record(value: unknown, context: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${context} contains unexpected field ${unknown}`);
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a non-negative finite number`);
  }
  return value;
}

function portableRelativePath(value: unknown, context: string): string {
  const parsed = nonEmptyString(value, context);
  if (parsed.includes('\\') || parsed.startsWith('/') || /^[a-zA-Z]:/u.test(parsed)) {
    throw new Error(`${context} must be a portable relative path inside the plugin directory`);
  }
  const normalized = parsed.startsWith('./') ? parsed.slice(2) : parsed;
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`${context} must be a portable relative path inside the plugin directory`);
  }
  return parsed;
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const result = value.map((item, index) => nonEmptyString(item, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicate values`);
  return result;
}

function parsePluginRequirements(value: unknown, pluginName: string): Readonly<{ plugins: readonly string[] }> {
  try {
    if (value === undefined) return Object.freeze({ plugins: Object.freeze([]) });
    const input = record(value, `Plugin ${pluginName} requires`);
    exactKeys(input, ['plugins'], `Plugin ${pluginName} requires`);
    const plugins = stringArray(input.plugins, `Plugin ${pluginName} requires.plugins`);
    if (plugins.some((dependency) => !PACKAGE_NAME_PATTERN.test(dependency))) {
      throw new Error(`Plugin ${pluginName} requires.plugins must contain valid plugin names`);
    }
    return Object.freeze({ plugins: Object.freeze(plugins) });
  } catch (error) {
    throw new PluginDependencyError(
      'PLUGIN_DEPENDENCY_INVALID',
      error instanceof Error ? error.message : `Plugin ${pluginName} requires is invalid`,
      { plugin: pluginName },
    );
  }
}

function parseMessageRoute(value: unknown, context: string): PluginMessageRouteDeclaration {
  if (Array.isArray(value)) return Object.freeze(stringArray(value, context));
  const input = record(value, context);
  exactKeys(input, ['methods', 'callers'], context);
  const methods = stringArray(input.methods, `${context}.methods`);
  if (input.callers === undefined) return Object.freeze({ methods });
  const callers = stringArray(input.callers, `${context}.callers`);
  if (callers.length === 0) throw new Error(`${context}.callers must not be empty`);
  if (callers.some((caller) => !PACKAGE_NAME_PATTERN.test(caller))) {
    throw new Error(`${context}.callers must contain valid plugin names`);
  }
  return Object.freeze({ methods, callers } satisfies PluginMessageRoute);
}

function parseMessageRoutes(value: unknown, context: string): Record<string, PluginMessageRouteDeclaration> {
  const input = record(value, context);
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([name, routes]) => [
    nonEmptyString(name, `${context} route name`),
    parseMessageRoute(routes, `${context}.${name}`),
  ])));
}

function parsePanel(value: unknown, context: string): PluginPanelManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object with an entry field`);
  }
  const input = record(value, context);
  exactKeys(input, [
    'entry', 'title', 'titleKey', 'width', 'height', 'minWidth', 'minHeight', 'multiInstance',
  ], context);
  const optionalString = (key: 'title' | 'titleKey') => input[key] === undefined
    ? undefined
    : nonEmptyString(input[key], `${context}.${key}`);
  const optionalNumber = (key: 'width' | 'height' | 'minWidth' | 'minHeight') => input[key] === undefined
    ? undefined
    : finiteNumber(input[key], `${context}.${key}`);
  if (input.multiInstance !== undefined && typeof input.multiInstance !== 'boolean') {
    throw new Error(`${context}.multiInstance must be a boolean`);
  }
  return Object.freeze({
    entry: portableRelativePath(input.entry, `${context}.entry`),
    ...(optionalString('title') === undefined ? {} : { title: optionalString('title') }),
    ...(optionalString('titleKey') === undefined ? {} : { titleKey: optionalString('titleKey') }),
    ...(optionalNumber('width') === undefined ? {} : { width: optionalNumber('width') }),
    ...(optionalNumber('height') === undefined ? {} : { height: optionalNumber('height') }),
    ...(optionalNumber('minWidth') === undefined ? {} : { minWidth: optionalNumber('minWidth') }),
    ...(optionalNumber('minHeight') === undefined ? {} : { minHeight: optionalNumber('minHeight') }),
    ...(input.multiInstance === undefined ? {} : { multiInstance: input.multiInstance }),
  });
}

function cloneJsonArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('not serializable');
    return Object.freeze(JSON.parse(json) as unknown[]);
  } catch (error) {
    throw new Error(`${context} must contain JSON-serializable values`, { cause: error });
  }
}

const MAX_CONTRIBUTE_DEPTH = 32;

function cloneJsonContribution(value: unknown, context: string, depth = 0, active = new WeakSet<object>()): unknown {
  if (depth > MAX_CONTRIBUTE_DEPTH) {
    throw new Error(`${context} exceeds the maximum nesting depth of ${MAX_CONTRIBUTE_DEPTH}`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`${context} must contain only JSON-safe values`);
  }
  if (typeof value !== 'object') {
    throw new Error(`${context} must contain only JSON-safe values`);
  }
  if (active.has(value)) {
    throw new Error(`${context} must not contain circular references`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${context} must contain only ordinary arrays`);
      }
      const keys = Reflect.ownKeys(value);
      const length = value.length;
      if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^\d+$/u.test(key)))) {
        throw new Error(`${context} must contain only JSON-safe arrays`);
      }
      if (keys.length !== length + 1 || !keys.includes('length')) {
        throw new Error(`${context} must not contain sparse or extended arrays`);
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
          throw new Error(`${context} must not contain sparse arrays`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${context} must contain only data values`);
        }
        result.push(cloneJsonContribution(descriptor.value, `${context}[${index}]`, depth + 1, active));
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`${context} must contain only ordinary objects`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(value, key))) {
      throw new Error(`${context} must contain only enumerable string fields`);
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error(`${context} must contain only string fields`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`${context}.${key} must be a data value`);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonContribution(descriptor.value, `${context}.${key}`, depth + 1, active),
        writable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

export function parsePluginPackageManifest(value: unknown): PluginPackageManifest {
  const pkg = record(value, 'Plugin package manifest');
  const name = nonEmptyString(pkg.name, 'Plugin package name');
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error('Plugin package name is invalid');
  const version = nonEmptyString(pkg.version, `Plugin ${name} version`);
  if (semver.valid(version) !== version) throw new Error(`Plugin ${name} version must be canonical SemVer`);
  const main = portableRelativePath(pkg.main, `Plugin ${name} main`);
  if (!/(^|\/)dist\/.+\.(?:mjs|cjs|js)$/u.test(main)) {
    throw new Error(`Plugin ${name} main must point to a dist JavaScript entry`);
  }

  const ceEditor = record(pkg['ce-editor'], `Plugin ${name} ce-editor`);
  exactKeys(ceEditor, ['schemaVersion', 'capabilities', 'assets', 'requires', 'contribute'], `Plugin ${name} ce-editor`);
  const schemaVersion = ceEditor.schemaVersion;
  if (schemaVersion !== PLUGIN_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Plugin ${name} has unsupported ce-editor.schemaVersion ${String(schemaVersion)}`);
  }

  const rawCapabilities = ceEditor.capabilities === undefined
    ? []
    : stringArray(ceEditor.capabilities, `Plugin ${name} capabilities`);
  const capabilities = rawCapabilities.map((capability) => {
    if (!(PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new Error(`Plugin ${name} capability ${capability} is unknown`);
    }
    return capability as PluginCapability;
  });

  const assetsInput = ceEditor.assets === undefined
    ? {}
    : record(ceEditor.assets, `Plugin ${name} assets`);
  exactKeys(assetsInput, ['public'], `Plugin ${name} assets`);
  const publicAssets = assetsInput.public === undefined
    ? []
    : stringArray(assetsInput.public, `Plugin ${name} public assets`).map((entry, index) => (
      portableRelativePath(entry, `Plugin ${name} public assets[${index}]`)
    ));
  const requires = parsePluginRequirements(ceEditor.requires, name);

  const contributeInput = ceEditor.contribute === undefined
    ? {}
    : record(ceEditor.contribute, `Plugin ${name} contribute`);
  const panelInput = contributeInput.panel === undefined
    ? undefined
    : record(contributeInput.panel, `Plugin ${name} panels`);
  const panels = panelInput === undefined ? undefined : Object.freeze(Object.fromEntries(
    Object.entries(panelInput).map(([panelName, panel]) => [
      nonEmptyString(panelName, `Plugin ${name} panel name`),
      parsePanel(panel, `Plugin ${name} panel ${panelName}`),
    ]),
  ));
  const messageInput = contributeInput.message === undefined
    ? undefined
    : record(contributeInput.message, `Plugin ${name} message`);
  if (messageInput) exactKeys(messageInput, ['request', 'broadcast'], `Plugin ${name} message`);
  const message = messageInput === undefined ? undefined : Object.freeze({
    ...(messageInput.request === undefined ? {} : {
      request: parseMessageRoutes(messageInput.request, `Plugin ${name} message.request`),
    }),
    ...(messageInput.broadcast === undefined ? {} : {
      broadcast: parseMessageRoutes(messageInput.broadcast, `Plugin ${name} message.broadcast`),
    }),
  });
  const unknownContributions = Object.fromEntries(Object.entries(contributeInput)
    .filter(([key]) => !['panel', 'menu', 'message'].includes(key))
    .map(([key, contribution]) => [
      key,
      cloneJsonContribution(contribution, `Plugin ${name} contribute.${key}`),
    ]));

  return Object.freeze({
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    name,
    version,
    main,
    capabilities: Object.freeze(capabilities),
    assets: Object.freeze({ public: Object.freeze(publicAssets) }),
    requires,
    contribute: Object.freeze({
      ...unknownContributions,
      ...(panels === undefined ? {} : { panel: panels }),
      ...(contributeInput.menu === undefined ? {} : {
        menu: cloneJsonArray(contributeInput.menu, `Plugin ${name} menu`),
      }),
      ...(message === undefined ? {} : { message }),
    }),
  });
}
