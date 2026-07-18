import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Editor } from '../editor/types';
import type { I18nVisibleSnapshot } from '../framework/i18n/types';
import type { PanelModule } from '../framework/panel';
import type { PanelRegistration } from '../framework/panel/types';

function escapeForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

type PanelAssetSource = PanelModule | Map<string, Editor>;

function getRegistration(source: PanelAssetSource, panelName: string): PanelRegistration | undefined {
  if (source instanceof Map) {
    for (const editor of source.values()) {
      const reg = editor.panel.getRegistration(panelName);
      if (reg) return reg;
    }
    return undefined;
  }
  return source.getRegistration(panelName);
}

function getEditor(source: PanelAssetSource, panelName: string, sessionId: string | null): Editor | undefined {
  if (!(source instanceof Map)) return undefined;
  if (sessionId) return source.get(sessionId);
  for (const editor of source.values()) {
    if (editor.panel.getRegistration(panelName)) return editor;
  }
  return undefined;
}

function getEditorForPlugin(source: PanelAssetSource, pluginName: string, sessionId: string | null): Editor | undefined {
  if (!(source instanceof Map)) return undefined;
  if (sessionId) {
    const editor = source.get(sessionId);
    return editor?.plugin.listLoaded().includes(pluginName) ? editor : undefined;
  }
  for (const editor of source.values()) {
    if (editor.plugin.listLoaded().includes(pluginName)) return editor;
  }
  return undefined;
}

function resolvePluginAsset(editor: Editor, pluginName: string, relativePath: string): string | null {
  const info = editor.plugin.getInfo(pluginName);
  const roots = info?.assets?.public;
  if (!info || !Array.isArray(roots) || roots.length === 0) return null;

  const pluginRoot = path.resolve(info.path);
  if (!existsSync(pluginRoot)) return null;
  const realPluginRoot = realpathSync(pluginRoot);
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const base = path.resolve(pluginRoot, root);
    if (base !== pluginRoot && !base.startsWith(pluginRoot + path.sep)) continue;
    if (!existsSync(base)) continue;
    const realBase = realpathSync(base);
    if (realBase !== realPluginRoot && !realBase.startsWith(realPluginRoot + path.sep)) continue;

    const candidate = path.resolve(base, relativePath);
    if (!candidate.startsWith(base + path.sep) || !existsSync(candidate)) continue;
    const realCandidate = realpathSync(candidate);
    if (!realCandidate.startsWith(realBase + path.sep)) continue;
    if (!statSync(realCandidate).isFile()) continue;
    return realCandidate;
  }
  return null;
}

function emptyI18nSnapshot(): I18nVisibleSnapshot {
  return {
    locale: 'zh-CN',
    defaultLocale: 'zh-CN',
    version: 0,
    currentMessages: {},
    defaultMessages: {},
  };
}

function createPanelRuntimeScript(panelName: string, panelPluginName: string, initialSnapshot: I18nVisibleSnapshot): string {
  const panelLiteral = escapeForScript(panelName);
  const panelPluginLiteral = escapeForScript(panelPluginName);
  const snapshotLiteral = escapeForScript(JSON.stringify(initialSnapshot));

  return `<script type="module">
    const panelName = ${panelLiteral};
    const panelPluginName = ${panelPluginLiteral};
    const sessionId = new URLSearchParams(window.location.search).get('sessionId') || '';
    window.__panelI18n = {
      snapshot: JSON.parse(${snapshotLiteral}),
      listeners: new Set(),
    };
    window.__panelDefinition = undefined;
    const channelName = \`ce-session:\${sessionId}\`;
    window.__panelChannel = createSessionChannel(channelName);
    window.parent.postMessage({ type: 'panel-ready', panel: panelName }, '*');

    function createSessionChannel(name) {
      if (typeof BroadcastChannel !== 'function') return null;
      try {
        return new BroadcastChannel(name);
      } catch {
        return null;
      }
    }

    function notifyPanelHost(message) {
      try {
        window.__panelChannel?.postMessage(message);
      } catch {
        // Fall back to host window messaging below.
      }
      const targets = [window.parent, window.opener];
      for (const target of targets) {
        if (!target || target === window) continue;
        try {
          target.postMessage(message, '*');
        } catch {
          // Ignore cross-window delivery failures.
        }
      }
    }

    function translate(key, params = {}) {
      const snapshot = window.__panelI18n.snapshot;
      const raw = snapshot.currentMessages[key] ?? snapshot.defaultMessages[key] ?? key;
      return raw.replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? \`{\${name}}\`));
    }

    function encodePanelAssetPath(relativePath) {
      return String(relativePath)
        .replace(/^\\/+/, '')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    }

    function createPanelAssetUrl(relativePath) {
      return \`/api/assets/plugin/\${encodeURIComponent(panelPluginName)}/\${encodePanelAssetPath(relativePath)}?sessionId=\${encodeURIComponent(sessionId)}\`;
    }

    function syncPanelI18n(payload) {
      if (!payload?.i18n) return;
      window.__panelI18n.snapshot = payload.i18n;
      const event = {
        type: payload.type,
        version: Number(payload.version ?? payload.i18n.version),
        ...(payload.type === 'locale-changed'
          ? { locale: String(payload.locale ?? payload.i18n.locale) }
          : {
              changedKeys: Array.isArray(payload.changedKeys) ? payload.changedKeys : [],
              affectsFallback: Boolean(payload.affectsFallback),
            }),
      };
      for (const listener of window.__panelI18n.listeners) {
        listener(event);
      }
    }

    async function dispatchPanelMessage(payload, respond) {
      if (!payload || payload.type !== 'panel-dispatch' || payload.panel !== panelName) return;
      const { method, args, requestId } = payload;
      const definition = window.__panelDefinition;
      const handlers = definition?.methods || {};
      const handler = handlers[method];
      if (!handler) return;
      try {
        const result = await handler(...(args || []));
        respond?.({ type: 'dispatch-result', requestId, result });
      } catch (err) {
        respond?.({ type: 'dispatch-result', requestId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    window.addEventListener('message', (event) => {
      syncPanelI18n(event.data);
      void dispatchPanelMessage(event.data, (result) => {
        window.parent.postMessage(result, '*');
      });
    });

    if (window.parent === window && sessionId) {
      const source = new EventSource(\`/sse/\${encodeURIComponent(sessionId)}\`);
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          syncPanelI18n(payload);
          void dispatchPanelMessage(payload);
        } catch {
          // Ignore malformed SSE payloads.
        }
      };
    }

    window.editor = {
      sessionId,
      assets: {
        url(relativePath) {
          return createPanelAssetUrl(relativePath);
        },
      },
      message: {
        async request(plugin, name, ...args) {
          const response = await fetch('/api/message/request', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, plugin, name, args }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || 'Panel message request failed');
          }
          return payload.result;
        },
        broadcast(topic, ...args) {
          void fetch('/api/message/broadcast', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, topic, args }),
          });
        },
      },
      i18n: {
        getLocale() {
          return window.__panelI18n.snapshot.locale;
        },
        t(key, params = {}) {
          return translate(key, params);
        },
        async setLocale(locale) {
          const response = await fetch(\`/api/i18n?sessionId=\${encodeURIComponent(sessionId)}\`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locale }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || 'Failed to set locale');
          }
          window.__panelI18n.snapshot = payload;
        },
        subscribe(listener) {
          window.__panelI18n.listeners.add(listener);
          return () => window.__panelI18n.listeners.delete(listener);
        },
      },
      async openPanel(panelName) {
        const response = await fetch('/api/panel/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, panelName }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to open panel');
        }

        if (payload.disposition === 'reuse' || !payload.url) {
          notifyPanelHost({ type: 'ce-open-panel-result', payload });
          return payload;
        }

        const popup = window.open(payload.url, \`_ce_\${payload.windowGroupId}\`);
        if (popup) {
          notifyPanelHost({ type: 'ce-open-panel-result', payload });
          return payload;
        }

        const fallbackResp = await fetch('/api/panel-instance/fallback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, panelInstanceId: payload.panelInstanceId }),
        });
        const fallback = await fallbackResp.json();
        if (!fallbackResp.ok) {
          throw new Error(fallback.error || 'Failed to fallback panel');
        }
        notifyPanelHost({ type: 'ce-open-panel-floating', payload: fallback });
        return { ...payload, carrier: 'floating', windowGroupId: null };
      },
      panel: {
        focus(name) {
          window.parent.postMessage({ type: 'panel-focus', panel: name }, '*');
        },
      },
      panelKey: panelName,
    };

    const panelModule = await import('./index.js');
    const definition = panelModule.default;
    if (!definition || typeof definition !== 'object') {
      throw new Error('Panel module must default-export a PanelDefinition object');
    }
    window.__panelDefinition = definition;
    await window.__panelDefinition?.mount?.(window.editor);
  </script>`;
}

function injectRuntimeIntoHtml(html: string, runtimeScript: string): string {
  if (/<body(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<body(\s[^>]*)?>/i, (match) => `${match}\n${runtimeScript}`);
  }
  return `${runtimeScript}\n${html}`;
}

export function createPanelAssetRouter(source: PanelAssetSource) {
  return function panelAssetRouter(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://localhost');
    const panelMatch = url.pathname.match(/^\/api\/assets\/panel\/([^/]+)\/(.+)$/);
    const pluginAssetMatch = url.pathname.match(/^\/api\/assets\/plugin\/([^/]+)\/(.+)$/);

    if (req.method !== 'GET') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (pluginAssetMatch) {
      const pluginName = safeDecodeURIComponent(pluginAssetMatch[1]);
      const filename = safeDecodeURIComponent(pluginAssetMatch[2]);
      if (!pluginName || filename === null) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Plugin asset not found' }));
        return;
      }
      const editor = getEditorForPlugin(source, pluginName, url.searchParams.get('sessionId'));
      const filePath = editor ? resolvePluginAsset(editor, pluginName, filename) : null;
      if (!filePath) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Plugin asset not found' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', getContentType(filePath));
      res.end(readFileSync(filePath));
      return;
    }

    if (panelMatch) {
      const panelName = safeDecodeURIComponent(panelMatch[1]);
      const relativePath = safeDecodeURIComponent(panelMatch[2]);
      if (!panelName || relativePath === null) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Panel asset not found' }));
        return;
      }

      const reg = getRegistration(source, panelName);
      if (!reg) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Panel "${panelName}" not found` }));
        return;
      }

      const baseDir = path.dirname(reg.module);
      const filePath = path.resolve(baseDir, relativePath);
      if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Panel asset not found' }));
        return;
      }

      if (relativePath === 'index.html') {
        const editor = getEditor(source, panelName, url.searchParams.get('sessionId'));
        const initialSnapshot = editor?.i18n.getVisibleSnapshot() ?? emptyI18nSnapshot();
        const html = injectRuntimeIntoHtml(
          readFileSync(reg.module, 'utf-8'),
          createPanelRuntimeScript(panelName, reg.owner, initialSnapshot),
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Panel asset not found' }));
        return;
      }

      const realBaseDir = realpathSync(baseDir);
      const realFilePath = realpathSync(filePath);
      if (!realFilePath.startsWith(realBaseDir + path.sep)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Panel asset not found' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', getContentType(realFilePath));
      res.end(readFileSync(realFilePath));
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.glb':
      return 'model/gltf-binary';
    case '.gltf':
      return 'model/gltf+json; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
