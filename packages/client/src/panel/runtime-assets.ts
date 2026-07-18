export function encodePanelAssetPath(relativePath: string): string {
  return relativePath
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function createPanelAssetUrl(pluginName: string, sessionId: string, relativePath: string): string {
  return `/api/assets/plugin/${encodeURIComponent(pluginName)}/${encodePanelAssetPath(relativePath)}?sessionId=${encodeURIComponent(sessionId)}`;
}
