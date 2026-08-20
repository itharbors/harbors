export interface SettingsPageContribution {
  schemaVersion: 2;
  panel: string;
  title: string;
  order?: number;
  requests: string[];
}

export interface SettingsPage {
  owner: string;
  panel: string;
  title: string;
  order: number;
  requests: string[];
  entry: string;
}

export class SettingsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsSchemaError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SettingsSchemaError(`${label} must be a non-empty string`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsSchemaError(`${label} must be a finite number`);
  }
}

/** Validate and normalize the v2 page contribution. Panel existence is checked by the host. */
export function validateSettingsContribution(pluginName: string, contribute: unknown): SettingsPageContribution {
  assertNonEmptyString(pluginName, 'pluginName');
  if (!isRecord(contribute) || !isRecord(contribute.settings)) {
    throw new SettingsSchemaError('contribute.settings must be an object');
  }
  const settings = contribute.settings;
  if (settings.schemaVersion !== 2) throw new SettingsSchemaError('settings.schemaVersion must be 2');
  assertNonEmptyString(settings.panel, 'settings.panel');
  assertNonEmptyString(settings.title, 'settings.title');
  const order = settings.order;
  if (order !== undefined) assertFiniteNumber(order, 'settings.order');
  if (!Array.isArray(settings.requests)) throw new SettingsSchemaError('settings.requests must be an array');
  const requests: string[] = [];
  for (const [index, request] of settings.requests.entries()) {
    assertNonEmptyString(request, `settings.requests[${index}]`);
    if (requests.includes(request)) throw new SettingsSchemaError(`duplicate settings request ${request}`);
    requests.push(request);
  }
  return {
    schemaVersion: 2,
    panel: settings.panel,
    title: settings.title,
    order: order === undefined ? 0 : order as number,
    requests,
  };
}

export function sortSettingsPages<T extends Pick<SettingsPage, 'owner' | 'panel' | 'title' | 'order'>>(pages: Iterable<T>): T[] {
  return [...pages].sort((left, right) => (
    left.order - right.order
    || left.title.localeCompare(right.title)
    || left.owner.localeCompare(right.owner)
    || left.panel.localeCompare(right.panel)
  ));
}
