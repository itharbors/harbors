export interface SettingsPageContribution {
  schemaVersion: 3;
  panel: string;
  order?: number;
}

export interface SettingsPage {
  owner: string;
  panel: string;
  title: string;
  order: number;
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

/** Validate and normalize the v3 page contribution. Panel existence is checked by the host. */
export function validateSettingsContribution(pluginName: string, contribute: unknown): SettingsPageContribution {
  assertNonEmptyString(pluginName, 'pluginName');
  if (!isRecord(contribute) || !isRecord(contribute.settings)) {
    throw new SettingsSchemaError('contribute.settings must be an object');
  }
  const settings = contribute.settings;
  if (settings.schemaVersion !== 3) throw new SettingsSchemaError('settings.schemaVersion must be 3');
  for (const key of Object.keys(settings)) {
    if (key !== 'schemaVersion' && key !== 'panel' && key !== 'order') {
      throw new SettingsSchemaError(`settings.${key} is not allowed`);
    }
  }
  assertNonEmptyString(settings.panel, 'settings.panel');
  const order = settings.order;
  if (order !== undefined) assertFiniteNumber(order, 'settings.order');
  return {
    schemaVersion: 3,
    panel: settings.panel,
    order: order === undefined ? 0 : order as number,
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
