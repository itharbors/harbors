import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

    const kitRoot = resolveKitRoot(editor, kit.name);
    if (!kitRoot) {
      throw new HttpError(404, 'KIT_ENTRY_NOT_FOUND', 'Kit entry not found');
    }

    const kind = match[1] as 'main' | 'secondary';
    const entry = kind === 'main' ? kit.windowEntries.main : kit.windowEntries.secondary;
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

function resolveKitRoot(editor: Editor, kitName: string): string | null {
  const pluginInfo = editor.plugin.getInfo(kitName);
  if (pluginInfo) return path.resolve(pluginInfo.path);

  for (const workspaceRoot of getWorkspaceRootCandidates()) {
    const workspaceKitRoot = findWorkspacePackageRoot(path.join(workspaceRoot, 'kits'), kitName);
    if (workspaceKitRoot) return workspaceKitRoot;

    const nodeModuleRoot = path.join(workspaceRoot, 'node_modules', ...kitName.split('/'));
    if (isPackageRoot(nodeModuleRoot, kitName)) return nodeModuleRoot;
  }

  return null;
}

function hasWindowGroup(editor: Editor, windowGroupId: string): boolean {
  return editor.window.getSnapshot().windows.some((windowGroup) => windowGroup.id === windowGroupId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getWorkspaceRootCandidates(): string[] {
  const cwd = process.cwd();
  return Array.from(new Set([
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '../..'),
  ]));
}

function findWorkspacePackageRoot(kitsDir: string, kitName: string): string | null {
  if (!existsSync(kitsDir)) return null;

  for (const item of readdirSync(kitsDir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const candidate = path.join(kitsDir, item.name);
    if (isPackageRoot(candidate, kitName)) return candidate;
  }

  return null;
}

function isPackageRoot(candidate: string, packageName: string): boolean {
  const packageJsonPath = path.join(candidate, 'package.json');
  if (!existsSync(packageJsonPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown };
    return pkg.name === packageName;
  } catch {
    return false;
  }
}
