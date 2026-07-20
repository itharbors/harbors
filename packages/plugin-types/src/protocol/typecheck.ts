import type { BootstrapInfo } from './bootstrap.js';
import type { ApiErrorBody } from './http.js';
import type { SSEEnvelope } from './message.js';
import type { PanelContext } from '../panel.js';
import { PROTOCOL_VERSION } from './version.js';

type Assert<T extends true> = T;
type PanelModalOpenArgument = Assert<Parameters<PanelContext['panel']['setModalOpen']>[0] extends boolean ? true : false>;
type GlobalPanelModalOpenArgument = Assert<Parameters<Window['editor']['panel']['setModalOpen']>[0] extends boolean ? true : false>;

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
