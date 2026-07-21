export type KitHostMode = 'single' | 'multi';

export interface PublicKitCatalogEntry {
  id: string;
  name: string;
  label: string;
}

export interface KitCatalogResponse {
  mode: KitHostMode;
  kits: PublicKitCatalogEntry[];
}
