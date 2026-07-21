import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KitHostMode } from '@itharbors/plugin-types';
import type { KitCatalogEntry } from '../assembly/kit-catalog';
import { HttpError } from '../http/errors';
import { sendJson } from '../http/json';

export function createKitCatalogRouter(
  mode: KitHostMode,
  catalogPromise: Promise<KitCatalogEntry[]>,
) {
  return async function kitCatalogRouter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const isCatalog = url.pathname === '/api/kits';
    const kitMatch = url.pathname.match(/^\/kits\/([^/]+)$/);

    if (!isCatalog && !kitMatch) {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    const catalog = await catalogPromise;
    if (isCatalog) {
      sendJson(res, 200, {
        mode,
        kits: catalog.map(({ id, name, label }) => ({ id, name, label })),
      });
      return;
    }

    const id = safeDecode(kitMatch?.[1] ?? '');
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new HttpError(404, 'KIT_NOT_FOUND', `Kit "${id}" not found`);
    }
    res.statusCode = 302;
    res.setHeader('Location', `/?kit=${encodeURIComponent(entry.name)}`);
    res.end();
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}
