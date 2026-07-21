import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { HttpError } from '../http/errors';
import { PROTOCOL_VERSION, type BootstrapInfo } from '@itharbors/plugin-types';

export function createBootstrapRouter(editorMap: Map<string, Editor>) {
  return async function bootstrapRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/bootstrap\/(.+)$/);

    if (!match || req.method !== 'GET') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const sessionId = decodeURIComponent(match[1]);
    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    const kit = editor.kit.getCurrent();
    const snapshot = kit ? editor.window.getSnapshot() : { windows: [], panelInstances: [] };
    const bootstrap = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: editor.sessionId,
      kitName: kit?.name ?? null,
      theme: kit?.theme ?? {},
      windowEntries: kit?.windowEntries ?? null,
      windows: snapshot.windows,
      panelInstances: snapshot.panelInstances,
      panels: editor.panel.list(),
      menuTree: editor.menu.getState().tree,
      applicationMenuTree: editor.menu.getApplicationState().tree,
      kitMenuTree: editor.menu.getKitState().tree,
      kitMenuRoot: kit?.menuRoot ?? null,
      i18n: editor.i18n.getVisibleSnapshot(),
    } satisfies BootstrapInfo;
    sendJson(res, 200, bootstrap);
  };
}
