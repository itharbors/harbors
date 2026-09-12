import { ContextStore } from './store.js';

declare const editor: any;

let store: ContextStore | undefined;

editor.plugin.define({
  lifecycle: {
    load(runtime: any) {
      store = new ContextStore(runtime.paths.data);
    },
    unload() {
      store?.close();
      store = undefined;
    },
  },
  methods: {
    getStatus: () => requireStore().getStatus(),
    createConversation: (input: any) => requireStore().createConversation(input),
    listConversations: (status?: any) => requireStore().listConversations(status),
    loadConversation: (id: string) => requireStore().loadConversation(id),
    appendEvent: (input: any) => requireStore().appendEvent(input),
    getConversationTrace: (id: string) => requireStore().getConversationTrace(id),
    getConversationTraceSince: (id: string, afterSeq?: number) => requireStore().getConversationTraceSince(id, afterSeq),
    buildContext: (input: any) => requireStore().buildContext(input),
    recallHistory: (input: any) => requireStore().recallHistory(input),
    archiveConversation: (id: string) => requireStore().archiveConversation(id),
    restoreConversation: (id: string) => requireStore().restoreConversation(id),
    deleteArchivedConversation: (id: string) => requireStore().deleteArchivedConversation(id),
  },
});

function requireStore(): ContextStore {
  if (!store) throw new Error('CONTEXT_STORE_NOT_READY');
  return store;
}
