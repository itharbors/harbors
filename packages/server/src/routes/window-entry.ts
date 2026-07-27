import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Editor } from '../editor/types';
import { HttpError } from '../http/errors';

export function createWindowEntryRouter(editorMap: Map<string, Editor>) {
  return async function windowEntryRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/window-entry\/(main|secondary)$/);

    if (!match || req.method !== 'GET') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const sessionId = url.searchParams.get('sessionId') || url.searchParams.get('session') || '';
    const editor = editorMap.get(sessionId);
    const kit = editor?.kit.getCurrent();
    if (!editor || !kit) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    const kitRoot = editor.kit.getCurrentDirectory();
    if (!kitRoot) {
      throw new HttpError(404, 'KIT_ENTRY_NOT_FOUND', 'Kit entry not found');
    }

    const kind = match[1] as 'main' | 'secondary';
    const entry = kind === 'main' ? kit.windowEntries.main : kit.windowEntries.secondary;
    if (!isRelativeEntry(entry)) {
      throw new HttpError(404, 'KIT_ENTRY_NOT_FOUND', 'Kit entry not found');
    }
    const entryPath = path.resolve(kitRoot, entry);
    if (!entryPath.startsWith(kitRoot + path.sep) || !existsSync(entryPath)) {
      throw new HttpError(404, 'KIT_ENTRY_NOT_FOUND', 'Kit entry not found');
    }

    const realKitRoot = realpathSync(kitRoot);
    const realEntryPath = realpathSync(entryPath);
    if (!realEntryPath.startsWith(realKitRoot + path.sep) || !statSync(realEntryPath).isFile()) {
      throw new HttpError(404, 'KIT_ENTRY_NOT_FOUND', 'Kit entry not found');
    }

    const windowGroupId = url.searchParams.get('windowGroupId');
    if (kind === 'secondary' && isNonEmptyString(windowGroupId) && hasWindowGroup(editor, windowGroupId)) {
      editor.window.markWindowGroupOpened(windowGroupId);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderWindowEntryHtml(readFileSync(realEntryPath, 'utf-8')));
  };
}

function renderWindowEntryHtml(html: string): string {
  return ensureWindowEntryStyle(rewriteClientEntryScript(html));
}

function rewriteClientEntryScript(html: string): string {
  const clientEntry = getClientEntryScript();
  return html.replace(
    /(<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'])\/assets\/index\.js(["'][^>]*><\/script>)/gu,
    `$1${clientEntry}$2`,
  );
}

function getClientEntryScript(): string {
  if (isNonEmptyString(process.env.CE_CLIENT_ENTRY)) return process.env.CE_CLIENT_ENTRY;
  return process.env.NODE_ENV === 'production' ? '/assets/index.js' : '/src/index.ts';
}

function ensureWindowEntryStyle(html: string): string {
  if (html.includes('data-ce-window-entry-style')) return html;
  return html.replace('</head>', `${WINDOW_ENTRY_STYLE}\n  </head>`);
}

const WINDOW_ENTRY_STYLE = `  <style data-ce-window-entry-style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html,
    body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
    }
    #app {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
  </style>`;

function hasWindowGroup(editor: Editor, windowGroupId: string): boolean {
  return editor.window.getSnapshot().windows.some((windowGroup) => windowGroup.id === windowGroupId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRelativeEntry(entry: string): boolean {
  return !path.isAbsolute(entry) && !entry.split(/[\\/]+/u).includes('..');
}
