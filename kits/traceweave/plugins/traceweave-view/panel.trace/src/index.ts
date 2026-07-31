import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from './app.js';
import { MessageTraceweaveClient, type MessageBridge } from './api.js';

interface PanelContext { message: MessageBridge }

let root: Root | undefined;

export default {
  async mount(context: PanelContext) {
    const container = document.querySelector<HTMLElement>('#traceweave-root');
    if (!container) throw new Error('TraceWeave root element not found');
    root = createRoot(container);
    root.render(createElement(App, { api: new MessageTraceweaveClient(context.message) }));
  },
  unmount() {
    root?.unmount();
    root = undefined;
  },
};
