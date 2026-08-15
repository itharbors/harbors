import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { SessionManager } from './session/manager';
import type { SSEChannel } from './sse/channel';
import { BrowserRequestBroker } from './framework/browser-request-broker';
import type { Editor } from './editor/types';
import { createSessionRouter } from './api/session';
import { createEditor } from './editor/index';
import { handleSSE } from './sse/handler';
import { createBootstrapRouter } from './routes/bootstrap';
import { createI18nRouter } from './routes/i18n';
import { createMessageBroadcastRouter } from './routes/message-broadcast';
import { createMessageRequestRouter } from './routes/message-request';
import { createMessageResultRouter } from './routes/message-result';
import { createMenuTriggerRouter } from './routes/menu-trigger';
import { createPanelAssetRouter } from './routes/panel-asset';
import { createPanelInstanceRouter } from './routes/panel-instance';
import { createPanelOpenRouter } from './routes/panel-open';
import { createWindowEntryRouter } from './routes/window-entry';
import { createWindowGroupRouter } from './routes/window-group';
import type { AssemblyConfig } from './assembly/config';
import { discoverKitCatalog } from './assembly/kit-catalog';
import { SessionRuntimeRegistry } from './session/runtime-registry';
import { HttpError } from './http/errors';
import { sendHttpError } from './http/json';
import type { ApplicationRuntime } from './application/runtime';
import { createApplicationBootstrapRouter } from './routes/application-bootstrap';
import { createApplicationEventsRouter } from './routes/application-events';
import { createApplicationMenuTriggerRouter } from './routes/application-menu-trigger';
import { createApplicationPluginRetryRouter } from './routes/application-plugin-retry';
import { createKitCatalogRouter } from './routes/kit-catalog';
import { createClientAssetRouter } from './routes/client-asset';
import type { PluginPathRoots } from '@itharbors/magnet';
import type { CredentialVault } from './credentials/vault';
import {
  createLocalWebFileRouter,
  LocalWebFileStore,
} from './routes/local-web-file';

type CredentialVaultBindingSource = Pick<CredentialVault, 'bind' | 'capability'>;

export interface AppOptions {
  assembly: AssemblyConfig;
  applicationRuntime: Pick<
    ApplicationRuntime,
    'getBootstrap' | 'request' | 'retryPlugin' | 'triggerMenu' | 'subscribe'
  >;
  applicationControlToken?: string;
  clientAssetsRoot?: string;
  pluginPathRoots: PluginPathRoots;
  credentialVault?: () => CredentialVaultBindingSource | undefined;
}

export function createApp(
  manager: SessionManager,
  channel: SSEChannel,
  appOptions: AppOptions,
  broker = new BrowserRequestBroker(),
) {
  const stopDisconnectHandling = channel.onSessionDisconnected((sessionId) => {
    broker.rejectSession(sessionId, new Error('Browser disconnected'));
  });
  const assembly = appOptions.assembly;
  let kitCatalogPromise: ReturnType<typeof discoverKitCatalog> | undefined;
  const loadKitCatalog = () => {
    kitCatalogPromise ??= discoverKitCatalog(assembly);
    return kitCatalogPromise;
  };
  const registry = new SessionRuntimeRegistry(manager, async (session, options) => {
    const credentialVault = appOptions.credentialVault?.();
    const editor = createEditor(session.sessionId, {
        assembly,
        pluginPathRoots: appOptions.pluginPathRoots,
        credentialVault,
        applicationRequest: (plugin, name, ...args) => (
          appOptions.applicationRuntime.request(plugin, name, ...args)
        ),
        initialLocale: options.locale,
        dispatchBrowserRequest: (panel, method, args) => broker.request(
          session.sessionId,
          (event) => channel.broadcast(session.sessionId, event),
          { panel, method, args },
        ),
        dispatchPanelBroadcast: (panel, method, args) => {
          channel.broadcast(session.sessionId, {
            type: 'panel-dispatch',
            panel,
            method,
            args,
          });
        },
        onLayoutChanged: (_sessionId, window) => {
          channel.broadcast(session.sessionId, {
            type: 'layout-changed',
            window,
          });
        },
        onMenuChanged: (_sessionId, state, applicationState, kitState) => {
          channel.broadcast(session.sessionId, {
            type: 'menu-changed',
            menuTree: state.tree,
            applicationMenuTree: applicationState.tree,
            kitMenuTree: kitState.tree,
          });
        },
    });
    editor.i18n.subscribe((event) => {
        channel.broadcast(session.sessionId, {
          ...event,
          i18n: editor.i18n.getVisibleSnapshot(),
          menuTree: editor.menu.getState().tree,
          applicationMenuTree: editor.menu.getApplicationState().tree,
          kitMenuTree: editor.menu.getKitState().tree,
        });
    });
    try {
      await editor.kit.load(options.kit ?? options.kitName ?? options.kitPath ?? assembly.defaultKit);
      return editor;
    } catch (loadError) {
      try {
        await editor.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [loadError, disposeError],
          `Session "${session.sessionId}" runtime creation and cleanup failed`,
        );
      }
      throw loadError;
    }
  });
  const editorMap = registry.editors as Map<string, Editor>;
  const localWebFiles = new LocalWebFileStore({
    rootDirectory: path.join(appOptions.pluginPathRoots.temp, 'local-web-files'),
  });
  const localWebFileRouter = createLocalWebFileRouter(manager, localWebFiles);
  const sessionRouter = createSessionRouter(manager, async (session, options) => {
    const requestedKit = options.kit ?? options.kitName ?? options.kitPath;
    const catalogEntry = requestedKit
      ? (await loadKitCatalog()).find((entry) => entry.name === requestedKit)
      : undefined;
    await registry.getOrCreate(session.sessionId, {
      ...options,
      ...(catalogEntry ? { kit: catalogEntry.directory } : {}),
      workspacePath: session.workspacePath,
    });
  }, async (sessionId) => {
    broker.rejectSession(sessionId, new Error('Session destroyed'));
    channel.closeSession(sessionId);
    const destroyed = await registry.destroy(sessionId);
    if (destroyed) await localWebFiles.cleanupSession(sessionId);
    return destroyed;
  });
  const bootstrapRouter = createBootstrapRouter(editorMap);
  const i18nRouter = createI18nRouter(editorMap);
  const panelAssetRouter = createPanelAssetRouter(editorMap);
  const messageRequestRouter = createMessageRequestRouter(editorMap);
  const messageBroadcastRouter = createMessageBroadcastRouter(editorMap);
  const messageResultRouter = createMessageResultRouter(broker);
  const menuTriggerRouter = createMenuTriggerRouter(editorMap);
  const windowEntryRouter = createWindowEntryRouter(editorMap);
  const windowGroupRouter = createWindowGroupRouter(editorMap);
  const panelOpenRouter = createPanelOpenRouter(editorMap);
  const panelInstanceRouter = createPanelInstanceRouter(editorMap);
  const applicationBootstrapRouter = createApplicationBootstrapRouter(appOptions.applicationRuntime);
  const applicationEventsRouter = createApplicationEventsRouter(appOptions.applicationRuntime);
  const applicationMenuTriggerRouter = createApplicationMenuTriggerRouter(
    appOptions.applicationRuntime,
    { controlToken: appOptions.applicationControlToken },
  );
  const applicationPluginRetryRouter = createApplicationPluginRetryRouter(
    appOptions.applicationRuntime,
    { controlToken: appOptions.applicationControlToken },
  );
  const kitCatalogRouter = createKitCatalogRouter(loadKitCatalog);
  const clientAssetRouter = appOptions.clientAssetsRoot
    ? createClientAssetRouter(appOptions.clientAssetsRoot)
    : undefined;

  const dispatchRequest = async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';

    if (url.startsWith('/sse/application')) {
      applicationEventsRouter(req, res);
      return;
    }

    // Session SSE endpoint
    if (url.startsWith('/sse/')) {
      handleSSE(req, res, channel);
      return;
    }

    // Health check
    if (url === '/api/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (url === '/api/kits' || url.startsWith('/api/kits?') || url.startsWith('/kits/')) {
      await kitCatalogRouter(req, res);
      return;
    }

    // Framework routes
    if (url.startsWith('/api/application/bootstrap')) {
      applicationBootstrapRouter(req, res);
      return;
    }
    if (url.startsWith('/api/application/menu/trigger')) {
      await applicationMenuTriggerRouter(req, res);
      return;
    }
    if (targetsApplicationPluginRetryRouter(url)) {
      await applicationPluginRetryRouter(req, res);
      return;
    }
    if (url.startsWith('/api/bootstrap/')) {
      await bootstrapRouter(req, res);
      return;
    }
    if (url.startsWith('/api/window-entry/')) {
      await windowEntryRouter(req, res);
      return;
    }
    if (url.startsWith('/api/window-group/')) {
      await windowGroupRouter(req, res);
      return;
    }
    if (url.startsWith('/api/i18n')) {
      await i18nRouter(req, res);
      return;
    }
    if (
      url.startsWith('/api/assets/panel/') ||
      url.startsWith('/api/assets/plugin/')
    ) {
      panelAssetRouter(req, res);
      return;
    }
    if (url.startsWith('/api/message/request')) {
      await messageRequestRouter(req, res);
      return;
    }
    if (url.startsWith('/api/message/broadcast')) {
      await messageBroadcastRouter(req, res);
      return;
    }
    if (url.startsWith('/api/message/result')) {
      await messageResultRouter(req, res);
      return;
    }
    if (url.startsWith('/api/menu/trigger')) {
      await menuTriggerRouter(req, res);
      return;
    }
    if (url.startsWith('/api/panel/open')) {
      await panelOpenRouter(req, res);
      return;
    }
    if (url.startsWith('/api/panel-instance/')) {
      await panelInstanceRouter(req, res);
      return;
    }
    if (url.startsWith('/api/local-file/')) {
      await localWebFileRouter(req, res);
      return;
    }

    // Legacy API routes
    if (url.startsWith('/api/')) {
      await sessionRouter(req, res);
      return;
    }

    if (clientAssetRouter) {
      if (await clientAssetRouter(req, res)) return;
      res.statusCode = 404;
      res.end();
      return;
    }

    // Fallback: serve index page (SPA)
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(INDEX_HTML);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await dispatchRequest(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendHttpError(res, error);
        return;
      }
      console.error('Unhandled request error:', error);
      sendHttpError(res, new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'));
    }
  };

  return {
    handleRequest,
    registry,
    editorMap,
    broker,
    localWebFiles,
    stopDisconnectHandling,
    prepareKitCatalog: loadKitCatalog,
  };
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#111722">
  <title>ITHARBORS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html,
    body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #111722;
      color: #d4d4d4;
    }
    #app {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/index.js"></script>
</body>
</html>`;

function targetsApplicationPluginRetryRouter(requestTarget: string): boolean {
  const routePrefix = '/api/application/plugin/retry';
  if (requestTarget.startsWith(routePrefix)) return true;
  if (!/^https?:\/\//iu.test(requestTarget)) return false;
  try {
    return new URL(requestTarget).pathname.startsWith(routePrefix);
  } catch {
    return false;
  }
}
