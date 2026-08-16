import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.js';

const setters: Record<string, (data: any) => void> = {};

export default {
  async mount(ctx: any) {
    const root = document.getElementById('panel-root');
    if (root) {
      createRoot(root).render(
        React.createElement(App, {
          ctx,
          registerSetter: (key: string, setter: (data: any) => void) => {
            setters[key] = setter;
          },
        })
      );
    }
  },
  methods: {
    onConversationChanged(data: unknown) {
      setters['conversation.changed']?.(data);
      return data;
    },
    onConversationSelected(data: unknown) {
      setters['conversation.selected']?.(data);
      return data;
    },
    onConversationDraft(data: unknown) {
      setters['conversation.draft']?.(data);
      return data;
    },
    onMessageDelta(data: unknown) {
      setters['message.delta']?.(data);
      return data;
    },
    onMessageStatus(data: unknown) {
      setters['message.status']?.(data);
      return data;
    },
    onMessageSent(data: unknown) {
      setters['message.sent']?.(data);
      return data;
    },
  },
};
