import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './app.js';

const setters: Record<string, (data: any) => void> = {};
let reactRoot: Root | null = null;

function unmount(): void {
  reactRoot?.unmount();
  reactRoot = null;
  for (const key of Object.keys(setters)) delete setters[key];
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
          registerSetter: (key: string, setter: (data: any) => void) => {
            setters[key] = setter;
          },
        })
      );
    }
  },
  unmount,
  methods: {
    onConversationChanged(data: unknown) {
      setters['agent.conversation.changed']?.(data);
      return data;
    },
    onConversationSelected(data: unknown) {
      setters['conversation.selected']?.(data);
      return data;
    },
  },
};
