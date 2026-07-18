declare const editor: any;

editor.plugin.define({
  lifecycle: {
    load(ctx) {
      runtime = ctx;
    },
  },
  methods: {
    openDebugPanel() {
      return runtime.window.openPanel('@ce/message-debug.debug');
    },
    getSnapshot() {
      return {
        timestamp: Date.now(),
        messages: [...messageLog],
      };
    },
    onAnyRequest(meta, ...args) {
      if (isInternalRequest(meta)) return;
      appendMessage({
        type: `Request ${formatRequest(meta)}`,
        payload: normalizeArgs(args),
      });
    },
    onAnyBroadcast(meta, ...args) {
      if (isBroadcastingSnapshot || isInternalBroadcast(meta)) return;
      appendMessage({
        type: `Broadcast ${formatBroadcast(meta)}`,
        payload: normalizeArgs(args),
      });
    },
    onDocumentChanged(payload) {
      appendMessage({ type: 'document.changed', payload });
    },
  },
});

const PLUGIN_NAME = '@ce/message-debug';
const MESSAGE_CHANGE_TOPIC = `${PLUGIN_NAME}.messages.changed`;

let runtime;
let isBroadcastingSnapshot = false;
const messageLog = [];

function appendMessage(message) {
  messageLog.push(message);

  if (!runtime) return;

  isBroadcastingSnapshot = true;
  try {
    runtime.message.broadcast(MESSAGE_CHANGE_TOPIC, [...messageLog]);
  } finally {
    isBroadcastingSnapshot = false;
  }
}

function formatRequest(meta) {
  if (!meta || typeof meta !== 'object') return 'unknown';
  const plugin = typeof meta.plugin === 'string' ? meta.plugin : 'unknown';
  const name = typeof meta.name === 'string' ? meta.name : 'unknown';
  return `${plugin}.${name}`;
}

function formatBroadcast(meta) {
  return typeof meta?.topic === 'string' ? meta.topic : 'unknown';
}

function isInternalRequest(meta) {
  return meta?.plugin === PLUGIN_NAME && meta?.name === 'getSnapshot';
}

function isInternalBroadcast(meta) {
  return meta?.topic === MESSAGE_CHANGE_TOPIC;
}

function normalizeArgs(args) {
  if (args.length === 0) return [];
  if (args.length === 1) return args[0];
  return args;
}
