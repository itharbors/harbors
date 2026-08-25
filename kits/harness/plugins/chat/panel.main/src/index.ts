import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './app.js';
import { createPanelEventBridge } from './panel-event-bridge.js';

const eventBridge = createPanelEventBridge();
let reactRoot: Root | null = null;

function unmount(): void {
  reactRoot?.unmount();
  reactRoot = null;
  eventBridge.reset();
}

export default {
  async mount(ctx: any) {
    unmount();
    const root = document.getElementById('panel-root');
    if (root) {
      reactRoot = createRoot(root);
      reactRoot.render(
        React.createElement(App, {
          ctx,
          registerSetter: eventBridge.registerSetter,
        })
      );
    }
  },
  unmount,
  methods: {
    onConversationChanged(data: unknown) {
      return eventBridge.onConversationChanged(data);
    },
    onConversationSelected(data: unknown) {
      return eventBridge.onConversationSelected(data);
    },
    onConversationTraceAppend(data: unknown) {
      return eventBridge.onConversationTraceAppend(data);
    },
    onMessageDelta(data: unknown) {
      return eventBridge.onMessageDelta(data);
    },
    onMessageStatus(data: unknown) {
      return eventBridge.onMessageStatus(data);
    },
    onModelCatalogChanged(data: unknown) {
      return eventBridge.onModelCatalogChanged(data);
    },
  },
};
