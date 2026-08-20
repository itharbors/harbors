export interface ModelCatalogOption {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  reasoningEfforts?: Array<{ id: string; name: string }>;
  serviceTiers?: Array<{ id: string; name: string }>;
  defaultReasoningEffort?: string;
  defaultServiceTier?: string;
}

export interface ModelCatalogPayload {
  revision: number;
  reason: 'provider-saved' | 'provider-deleted' | 'credential-reset';
  catalog: {
    models: ModelCatalogOption[];
    defaultModel: string;
    configurationError?: string;
  };
}

export interface AppliedModelCatalog {
  models: ModelCatalogOption[];
  model: string;
  configurationError: string | null;
  revision: number;
}

export function selectModelForCatalog(currentModel: string, catalog: ModelCatalogPayload['catalog']): string {
  return catalog.models.some((item) => item.id === currentModel)
    ? currentModel
    : catalog.defaultModel || catalog.models[0]?.id || '';
}

function readOptionList(value: unknown): Array<{ id: string; name: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((item) => {
    if (typeof item === 'string' && item) return [{ id: item, name: item }];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) return [];
    return [{ id: record.id, name: typeof record.name === 'string' && record.name ? record.name : record.id }];
  });
  return options;
}

function readConfigurationError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function readModel(value: unknown): ModelCatalogOption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  const model: ModelCatalogOption = {
    id: record.id,
    name: typeof record.name === 'string' && record.name ? record.name : record.id,
  };
  if (typeof record.description === 'string') model.description = record.description;
  if (typeof record.contextWindow === 'number' && Number.isFinite(record.contextWindow) && record.contextWindow > 0) model.contextWindow = record.contextWindow;
  const reasoningEfforts = readOptionList(record.reasoningEfforts);
  if (reasoningEfforts) model.reasoningEfforts = reasoningEfforts;
  const serviceTiers = readOptionList(record.serviceTiers);
  if (serviceTiers) model.serviceTiers = serviceTiers;
  if (typeof record.defaultReasoningEffort === 'string' && record.defaultReasoningEffort) model.defaultReasoningEffort = record.defaultReasoningEffort;
  if (typeof record.defaultServiceTier === 'string' && record.defaultServiceTier) model.defaultServiceTier = record.defaultServiceTier;
  return model;
}

export function readModelCatalogPayload(value: unknown): ModelCatalogPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!Number.isSafeInteger(payload.revision)) return null;
  if (payload.reason !== 'provider-saved' && payload.reason !== 'provider-deleted' && payload.reason !== 'credential-reset') return null;
  if (!payload.catalog || typeof payload.catalog !== 'object' || Array.isArray(payload.catalog)) return null;
  const catalog = payload.catalog as Record<string, unknown>;
  const models = Array.isArray(catalog.models) ? catalog.models.map(readModel).filter((item): item is ModelCatalogOption => item !== null) : [];
  const defaultModel = typeof catalog.defaultModel === 'string' ? catalog.defaultModel : '';
  return {
    revision: payload.revision as number,
    reason: payload.reason,
    catalog: {
      models,
      defaultModel,
      ...(readConfigurationError(catalog.configurationError) ? { configurationError: readConfigurationError(catalog.configurationError) } : {}),
    },
  };
}

export function applyModelCatalog(currentModel: string, value: unknown): AppliedModelCatalog | null {
  const payload = readModelCatalogPayload(value);
  if (!payload) return null;
  return {
    models: payload.catalog.models,
    model: selectModelForCatalog(currentModel, payload.catalog),
    configurationError: payload.catalog.configurationError || null,
    revision: payload.revision,
  };
}
