export interface PublicKitCatalogEntry {
  id: string;
  name: string;
  label: string;
}

export interface KitCatalogResponse {
  kits: PublicKitCatalogEntry[];
}
