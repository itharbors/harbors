import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.js';

const setters: Record<string, (data: any) => void> = {};
let cachedConversationSelected: unknown;
let hasCachedConversationSelected = false;
const cachedTraceAppends: unknown[] = [];

function registerSetter(key: string, setter: (data: any) => void): void {
  setters[key] = setter;
  if (key === 'conversation.selected' && hasCachedConversationSelected) {
    setter(cachedConversationSelected);
  }
  if (key === 'conversation.trace.append' && cachedTraceAppends.length > 0) {
    const pending = cachedTraceAppends.splice(0);
    for (const value of pending) setter(value);
  }
}

export default {
  async mount(ctx: any) {
    const root = document.getElementById('panel-root');
    if (root) {
      createRoot(root).render(
        React.createElement(App, {
          ctx,
          registerSetter,
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
      cachedConversationSelected = data;
      hasCachedConversationSelected = true;
      setters['conversation.selected']?.(data);
      return data;
    },
    onConversationTraceAppend(data: unknown) {
      const setter = setters['conversation.trace.append'];
      if (setter) setter(data);
      else {
        cachedTraceAppends.push(data);
        if (cachedTraceAppends.length > 256) cachedTraceAppends.shift();
      }
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
  },
};
