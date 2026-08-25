type Setter = (data: any) => void;

export function createPanelEventBridge() {
  const setters: Record<string, Setter> = {};
  let cachedConversationSelected: unknown;
  let hasCachedConversationSelected = false;
  const cachedTraceAppends: unknown[] = [];
  let cachedModelCatalog: unknown;
  let hasCachedModelCatalog = false;

  return {
    reset(): void {
      for (const key of Object.keys(setters)) delete setters[key];
      cachedConversationSelected = undefined;
      hasCachedConversationSelected = false;
      cachedTraceAppends.length = 0;
      cachedModelCatalog = undefined;
      hasCachedModelCatalog = false;
    },

    registerSetter(key: string, setter: Setter): void {
      setters[key] = setter;
      if (key === 'conversation.selected' && hasCachedConversationSelected) setter(cachedConversationSelected);
      if (key === 'agent.conversation.trace.append' && cachedTraceAppends.length > 0) {
        const pending = cachedTraceAppends.splice(0);
        for (const value of pending) setter(value);
      }
      if (key === 'model-service.catalog.changed' && hasCachedModelCatalog) setter(cachedModelCatalog);
    },

    onConversationChanged(data: unknown): unknown {
      setters['agent.conversation.changed']?.(data);
      return data;
    },

    onConversationSelected(data: unknown): unknown {
      cachedConversationSelected = data;
      hasCachedConversationSelected = true;
      setters['conversation.selected']?.(data);
      return data;
    },

    onConversationTraceAppend(data: unknown): unknown {
      const setter = setters['agent.conversation.trace.append'];
      if (setter) setter(data);
      else {
        cachedTraceAppends.push(data);
        if (cachedTraceAppends.length > 256) cachedTraceAppends.shift();
      }
      return data;
    },

    onMessageDelta(data: unknown): unknown {
      setters['agent.message.delta']?.(data);
      return data;
    },

    onMessageStatus(data: unknown): unknown {
      setters['agent.message.status']?.(data);
      return data;
    },

    onModelCatalogChanged(data: unknown): unknown {
      cachedModelCatalog = data;
      hasCachedModelCatalog = true;
      setters['model-service.catalog.changed']?.(data);
      return data;
    },
  };
}
