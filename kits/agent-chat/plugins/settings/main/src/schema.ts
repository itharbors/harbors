export type SettingsLayer = 'global';
export type ConfigLayer = 'default' | SettingsLayer;
export type SettingsControl = 'text' | 'textarea' | 'number' | 'toggle' | 'select';
export type SettingsValue = string | number | boolean;

export interface SettingsOption {
  label: string;
  value: string | number;
}

export interface SettingsField {
  key: string;
  label: string;
  description?: string;
  control: SettingsControl;
  defaultValue?: SettingsValue;
  layers: SettingsLayer[];
  defaultLayer: SettingsLayer;
  options?: SettingsOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  order?: number;
}

export interface SettingsSection {
  id: string;
  title: string;
  description?: string;
  order?: number;
  fields: SettingsField[];
}

export interface SettingsProvider {
  owner: string;
  sections: SettingsSection[];
}

export interface SettingsFieldViewModel {
  owner: string;
  section: string;
  field: SettingsField;
  resolvedValue: SettingsValue | null;
  resolvedLayer: ConfigLayer | null;
  perLayer: Record<ConfigLayer, SettingsValue | null>;
}

export interface SettingsSectionViewModel {
  owner: string;
  section: Pick<SettingsSection, 'id' | 'title' | 'description' | 'order'>;
  fields: SettingsFieldViewModel[];
}

export interface SettingsViewModel {
  sections: SettingsSectionViewModel[];
}

export class SettingsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsSchemaError';
  }
}

const CONTROLS = new Set<SettingsControl>(['text', 'textarea', 'number', 'toggle', 'select']);
const LAYERS = new Set<SettingsLayer>(['global']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SettingsSchemaError(`${label} must be a non-empty string`);
  }
}

function assertOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsSchemaError(`${label} must be a finite number`);
  }
  return value;
}

function assertOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SettingsSchemaError(`${label} must be a string`);
  return value;
}

function sameOptionValue(left: string | number, right: unknown): boolean {
  return left === right;
}

function isSettingsValue(value: unknown): value is SettingsValue {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
}

function validateFieldValue(field: Pick<SettingsField, 'control' | 'options' | 'min' | 'max' | 'step'>, value: unknown): string | undefined {
  if (!isSettingsValue(value)) return 'value must be a string, finite number, or boolean';
  if (field.control === 'text' || field.control === 'textarea') {
    return typeof value === 'string' ? undefined : `${field.control} value must be a string`;
  }
  if (field.control === 'toggle') return typeof value === 'boolean' ? undefined : 'toggle value must be a boolean';
  if (field.control === 'number') {
    if (typeof value !== 'number') return 'number value must be a finite number';
    if (field.min !== undefined && value < field.min) return `value must be at least ${field.min}`;
    if (field.max !== undefined && value > field.max) return `value must be at most ${field.max}`;
    if (field.step !== undefined) {
      const origin = field.min ?? 0;
      const quotient = (value - origin) / field.step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `value must use step ${field.step}`;
    }
    return undefined;
  }
  return field.options?.some((option) => sameOptionValue(option.value, value)) ? undefined : 'value must match one of the select options';
}

function normalizeField(owner: string, raw: unknown, fieldIndex: number): SettingsField {
  if (!isRecord(raw)) throw new SettingsSchemaError(`settings.sections[*].fields[${fieldIndex}] must be an object`);
  assertString(raw.key, `field ${fieldIndex}.key`);
  assertString(raw.label, `field ${raw.key}.label`);
  assertString(raw.control, `field ${raw.key}.control`);
  if (!CONTROLS.has(raw.control as SettingsControl)) throw new SettingsSchemaError(`field ${raw.key}.control is invalid`);
  if (!raw.key.startsWith(`${owner}.`)) throw new SettingsSchemaError(`field ${raw.key}.key must start with owner ${owner}.`);

  const control = raw.control as SettingsControl;
  const layers = raw.layers === undefined ? ['global'] : raw.layers;
  if (!Array.isArray(layers) || layers.length === 0 || layers.some((layer) => typeof layer !== 'string' || !LAYERS.has(layer as SettingsLayer))) {
    throw new SettingsSchemaError(`field ${raw.key}.layers must contain only global`);
  }
  const normalizedLayers = [...new Set(layers as SettingsLayer[])];
  const defaultLayer = raw.defaultLayer === undefined ? 'global' : raw.defaultLayer;
  if (typeof defaultLayer !== 'string' || defaultLayer !== 'global' || !normalizedLayers.includes('global')) {
    throw new SettingsSchemaError(`field ${raw.key}.defaultLayer must be global`);
  }

  const options = raw.options;
  let normalizedOptions: SettingsOption[] | undefined;
  if (control === 'select') {
    if (!Array.isArray(options) || options.length === 0) throw new SettingsSchemaError(`select field ${raw.key} requires options`);
    const optionValues = new Set<string | number>();
    const domValues = new Set<string>();
    normalizedOptions = options.map((option, optionIndex) => {
      if (!isRecord(option)) throw new SettingsSchemaError(`field ${raw.key}.options[${optionIndex}] must be an object`);
      assertString(option.label, `field ${raw.key}.options[${optionIndex}].label`);
      if ((typeof option.value !== 'string' && typeof option.value !== 'number') || (typeof option.value === 'number' && !Number.isFinite(option.value))) {
        throw new SettingsSchemaError(`field ${raw.key}.options[${optionIndex}].value must be a string or finite number`);
      }
      if (optionValues.has(option.value)) throw new SettingsSchemaError(`field ${raw.key} has duplicate option values`);
      if (domValues.has(String(option.value))) throw new SettingsSchemaError(`field ${raw.key} has ambiguous option values`);
      optionValues.add(option.value);
      domValues.add(String(option.value));
      return { label: option.label, value: option.value };
    });
  } else if (options !== undefined) {
    throw new SettingsSchemaError(`field ${raw.key}.options is only valid for select controls`);
  }

  const min = assertOptionalNumber(raw.min, `field ${raw.key}.min`);
  const max = assertOptionalNumber(raw.max, `field ${raw.key}.max`);
  const step = assertOptionalNumber(raw.step, `field ${raw.key}.step`);
  if (control !== 'number' && (min !== undefined || max !== undefined || step !== undefined)) {
    throw new SettingsSchemaError(`field ${raw.key}.min/max/step are only valid for number controls`);
  }
  if (step !== undefined && step <= 0) throw new SettingsSchemaError(`field ${raw.key}.step must be greater than zero`);
  if (min !== undefined && max !== undefined && min > max) throw new SettingsSchemaError(`field ${raw.key}.min must not exceed max`);

  const field: SettingsField = {
    key: raw.key,
    label: raw.label,
    ...(assertOptionalString(raw.description, `field ${raw.key}.description`) === undefined ? {} : { description: raw.description as string }),
    control,
    layers: normalizedLayers,
    defaultLayer: defaultLayer as SettingsLayer,
    ...(normalizedOptions ? { options: normalizedOptions } : {}),
    ...(assertOptionalString(raw.placeholder, `field ${raw.key}.placeholder`) === undefined ? {} : { placeholder: raw.placeholder as string }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
    ...(assertOptionalNumber(raw.order, `field ${raw.key}.order`) === undefined ? {} : { order: raw.order as number }),
  };
  if (hasOwn(raw, 'defaultValue')) {
    if (!isSettingsValue(raw.defaultValue)) throw new SettingsSchemaError(`field ${raw.key}.defaultValue is invalid`);
    const error = validateFieldValue(field, raw.defaultValue);
    if (error) throw new SettingsSchemaError(`field ${raw.key}.defaultValue ${error}`);
    field.defaultValue = raw.defaultValue;
  }
  return field;
}

export function validateSettingsContribution(pluginName: string, contribute: unknown, existingKeys: Iterable<string> = []): SettingsProvider {
  assertString(pluginName, 'pluginName');
  if (!isRecord(contribute) || !isRecord(contribute.settings)) throw new SettingsSchemaError('contribute.settings must be an object');
  const settings = contribute.settings;
  if (settings.schemaVersion !== 1) throw new SettingsSchemaError('settings.schemaVersion must be 1');
  if (!Array.isArray(settings.sections)) throw new SettingsSchemaError('settings.sections must be an array');

  const keys = new Set(existingKeys);
  const localKeys = new Set<string>();
  const sectionIds = new Set<string>();
  const sections = settings.sections.map((rawSection, sectionIndex) => {
    if (!isRecord(rawSection)) throw new SettingsSchemaError(`settings.sections[${sectionIndex}] must be an object`);
    assertString(rawSection.id, `section ${sectionIndex}.id`);
    assertString(rawSection.title, `section ${rawSection.id}.title`);
    if (sectionIds.has(rawSection.id)) throw new SettingsSchemaError(`duplicate section id ${rawSection.id}`);
    sectionIds.add(rawSection.id);
    if (!Array.isArray(rawSection.fields)) throw new SettingsSchemaError(`section ${rawSection.id}.fields must be an array`);
    const order = assertOptionalNumber(rawSection.order, `section ${rawSection.id}.order`);
    const fields = rawSection.fields.map((rawField, fieldIndex) => {
      const field = normalizeField(pluginName, rawField, fieldIndex);
      if (localKeys.has(field.key) || keys.has(field.key)) throw new SettingsSchemaError(`duplicate setting key ${field.key}`);
      localKeys.add(field.key);
      return field;
    });
    return {
      id: rawSection.id,
      title: rawSection.title,
      ...(assertOptionalString(rawSection.description, `section ${rawSection.id}.description`) === undefined ? {} : { description: rawSection.description as string }),
      ...(order === undefined ? {} : { order }),
      fields,
    };
  });
  return { owner: pluginName, sections };
}

export function findSetting(provider: SettingsProvider, key: string): SettingsField | undefined {
  for (const section of provider.sections) {
    const field = section.fields.find((candidate) => candidate.key === key);
    if (field) return field;
  }
  return undefined;
}

export function validateSettingValue(field: SettingsField, value: unknown): void {
  const error = validateFieldValue(field, value);
  if (error) throw new SettingsSchemaError(`field ${field.key} ${error}`);
}

export function buildSettingsViewModel(
  providers: Iterable<SettingsProvider>,
  getValue: (key: string, layer: ConfigLayer) => unknown,
): SettingsViewModel {
  const sections: SettingsSectionViewModel[] = [];
  for (const provider of providers) {
    for (const section of provider.sections) {
      const fields = [...section.fields]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
        .map((field): SettingsFieldViewModel => {
          const perLayer = {
            default: normalizeViewValue(getValue(field.key, 'default')),
            global: normalizeViewValue(getValue(field.key, 'global')),
          };
          const candidates: Array<[SettingsLayer | 'default', SettingsValue | null]> = [
            ['global', perLayer.global],
            ['default', perLayer.default],
          ];
          const resolved = candidates.find(([layer, value]) => value !== null && (layer === 'default' || field.layers.includes(layer)));
          return {
            owner: provider.owner,
            section: section.id,
            field: { ...field, layers: [...field.layers], ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}) },
            resolvedValue: resolved?.[1] ?? null,
            resolvedLayer: resolved?.[0] ?? null,
            perLayer,
          };
        });
      sections.push({
        owner: provider.owner,
        section: {
          id: section.id,
          title: section.title,
          ...(section.description === undefined ? {} : { description: section.description }),
          ...(section.order === undefined ? {} : { order: section.order }),
        },
        fields,
      });
    }
  }
  sections.sort((a, b) => a.owner.localeCompare(b.owner) || (a.section.order ?? 0) - (b.section.order ?? 0) || a.section.title.localeCompare(b.section.title));
  return { sections };
}

function normalizeViewValue(value: unknown): SettingsValue | null {
  return isSettingsValue(value) ? value : null;
}
