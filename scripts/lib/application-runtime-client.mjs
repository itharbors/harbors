import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

export async function fetchApplicationBootstrap(baseUrl, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(new URL('/api/application/bootstrap', baseUrl));
  const payload = await readJson(response);
  if (!response.ok) throw responseError(response, payload);
  if (!payload || typeof payload !== 'object' || !['ready', 'degraded', 'starting'].includes(payload.phase)) {
    throw new Error('Framework returned an invalid application bootstrap');
  }
  return payload;
}

export async function triggerApplicationMenu(
  baseUrl,
  menuId,
  controlToken,
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(new URL('/api/application/menu/trigger', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-harbors-application-token': controlToken,
    },
    body: JSON.stringify({ menuId }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw responseError(response, payload);
  return payload?.result;
}

export async function validateInstalledKitRuntime(
  baseUrl,
  bootstrap,
  kitId,
  {
    fetchImpl = globalThis.fetch,
    sessionId = `kit-activation-${randomUUID()}`,
  } = {},
) {
  if (typeof kitId !== 'string' || kitId.length === 0) throw new TypeError('Kit id is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const failedPlugin = Array.isArray(bootstrap?.plugins)
    ? bootstrap.plugins.find((plugin) => (
      plugin?.status === 'failed'
      && Array.isArray(plugin.kits)
      && plugin.kits.includes(kitId)
    ))
    : undefined;
  if (failedPlugin) {
    throw new Error(
      `Kit ${kitId} startup plugin ${String(failedPlugin.name)} failed: ${String(failedPlugin.error)}`,
    );
  }
  const diagnostic = Array.isArray(bootstrap?.diagnostics)
    ? bootstrap.diagnostics.find((item) => item?.kit === kitId)
    : undefined;
  if (diagnostic) {
    throw new Error(`Kit ${kitId} startup validation failed: ${String(diagnostic.message)}`);
  }

  const response = await fetchImpl(new URL('/api/session', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, kit: kitId }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw responseError(response, payload);

  const cleanup = await fetchImpl(
    new URL(`/api/session/${encodeURIComponent(sessionId)}`, baseUrl),
    { method: 'DELETE' },
  );
  if (!cleanup.ok) throw new Error(`Framework could not close Kit validation session (HTTP ${cleanup.status})`);
}

export function createApplicationEventParser(onEvent) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data));
          } catch {
            // A malformed event must not tear down the long-lived stream.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    },
  };
}

export function createApplicationRuntimeClient({
  baseUrl,
  onBootstrap,
  onError = () => undefined,
  connect = connectEventStream,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (handle) => clearTimeout(handle),
  reconnectDelayMs = 500,
}) {
  let closed = false;
  let connection;
  let reconnectHandle;

  const scheduleReconnect = () => {
    if (closed || reconnectHandle !== undefined) return;
    reconnectHandle = schedule(() => {
      reconnectHandle = undefined;
      open();
    }, reconnectDelayMs);
  };

  const open = () => {
    if (closed) return;
    const parser = createApplicationEventParser((event) => {
      if (event?.type === 'application-bootstrap' && event.bootstrap) {
        onBootstrap(event.bootstrap);
      }
    });
    connection = connect(new URL('/sse/application', baseUrl), {
      onData: (chunk) => parser.push(chunk),
      onEnd: scheduleReconnect,
      onError(error) {
        onError(error);
        scheduleReconnect();
      },
    });
  };

  return {
    startEvents() {
      open();
    },
    close() {
      if (closed) return;
      closed = true;
      if (reconnectHandle !== undefined) cancelSchedule(reconnectHandle);
      reconnectHandle = undefined;
      connection?.close();
      connection = undefined;
    },
  };
}

function connectEventStream(url, handlers) {
  const transport = url.protocol === 'https:' ? https : http;
  const request = transport.get(url, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      handlers.onError(new Error(`Application event stream returned HTTP ${response.statusCode}`));
      return;
    }
    response.setEncoding('utf8');
    response.on('data', handlers.onData);
    response.on('end', handlers.onEnd);
    response.on('error', handlers.onError);
  });
  request.on('error', handlers.onError);
  return { close: () => request.destroy() };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Framework returned invalid JSON with HTTP ${response.status}`);
  }
}

function responseError(response, payload) {
  const message = payload?.error?.message;
  return new Error(typeof message === 'string' ? message : `Framework returned HTTP ${response.status}`);
}
