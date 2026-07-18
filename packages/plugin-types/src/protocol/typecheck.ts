import type { BootstrapInfo } from './bootstrap.js';
import type { ApiErrorBody } from './http.js';
import type { SSEEnvelope } from './message.js';
import { PROTOCOL_VERSION } from './version.js';

const bootstrap: BootstrapInfo = {
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 'session',
  kitName: null,
  theme: {},
  windowEntries: null,
  windows: [],
  panelInstances: [],
  panels: [],
  menuTree: [],
  i18n: {
    locale: 'zh-CN',
    defaultLocale: 'zh-CN',
    version: 1,
    currentMessages: {},
    defaultMessages: {},
  },
};

const event: SSEEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'connected',
  sessionId: 'session',
};

const error: ApiErrorBody = {
  error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: null },
};

void [bootstrap, event, error];
