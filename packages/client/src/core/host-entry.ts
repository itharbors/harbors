import type { KitCatalogResponse } from '@itharbors/plugin-types';

export type HostEntry = 'picker' | 'editor';

export function selectHostEntry(url: URL): HostEntry {
  if (url.pathname !== '/') return 'editor';
  for (const parameter of ['session', 'sessionId', 'kit', 'page']) {
    if (url.searchParams.has(parameter)) return 'editor';
  }
  return 'picker';
}

export function isKitCatalogResponse(value: unknown): value is KitCatalogResponse {
  if (!isRecord(value)) return false;
  return Array.isArray(value.kits) && value.kits.every((entry) => (
    isRecord(entry)
    && isNonEmptyString(entry.id)
    && isNonEmptyString(entry.name)
    && isNonEmptyString(entry.label)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
