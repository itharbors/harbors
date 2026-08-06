import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const never = () => new Promise(() => undefined);
let counter = 0;
let generation;
let lateMarkerPath;
let staleMarkerPath;
const parentSend = process.send?.bind(process);

globalThis.editor.plugin.define({
  lifecycle: {
    load(runtime) {
      lateMarkerPath = path.join(runtime.paths.temp, 'late-old-generation.log');
      staleMarkerPath = path.join(runtime.paths.temp, 'stale-generation-delivery.log');
      if (parentSend) {
        process.send = (message, ...args) => {
          if (!generation && message && typeof message === 'object'
            && typeof message.generation === 'string') {
            generation = message.generation;
          }
          return parentSend(message, ...args);
        };
      }
      runtime.message.registerRequest('', 'manualPing', () => ({
        pid: process.pid,
        counter,
        lateAttempts: lateMarkerPath ? readLateAttempts(lateMarkerPath) : 0,
        staleDeliveries: staleMarkerPath ? readLateAttempts(staleMarkerPath) : 0,
      }), 'server');
      return sendStaleGenerationEnvelope();
    },
    unload() {
      if (!parentSend || !generation) return undefined;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (!process.connected) {
            resolve();
            return;
          }
          parentSend({
            protocol: 1,
            generation,
            kind: 'request',
            requestId: '9007199254740990',
            method: 'runtime-command',
            payload: {
              target: 'message',
              operation: 'register-request',
              owner: '@acceptance/crashing',
              name: 'lateOldGeneration',
              handlerId: 'handler-9007199254740990',
              location: 'server',
            },
          }, (error) => {
            if (error) {
              reject(error);
              return;
            }
            appendFileSync(lateMarkerPath, `${generation}\n`);
            resolve();
          });
        }, 25);
      });
    },
  },
  methods: {
    ping() {
      counter += 1;
      return { pid: process.pid, counter };
    },
    crashUncaught() {
      setImmediate(() => {
        throw new Error('acceptance uncaught crash');
      });
      return never();
    },
    crashRejection() {
      setImmediate(() => {
        void Promise.reject(new Error('acceptance rejection crash'));
      });
      return never();
    },
    exit42() {
      process.exit(42);
    },
  },
});

function sendStaleGenerationEnvelope() {
  if (!parentSend || !generation || !staleMarkerPath) return;
  const match = /^generation-(\d+)$/u.exec(generation);
  const generationNumber = Number(match?.[1]);
  if (!Number.isSafeInteger(generationNumber) || generationNumber <= 1) return;
  const staleGeneration = `generation-${generationNumber - 1}`;
  return new Promise((resolve, reject) => {
    parentSend({
      protocol: 1,
      generation: staleGeneration,
      kind: 'request',
      requestId: '9007199254740990',
      method: 'runtime-command',
      payload: {
        target: 'message',
        operation: 'register-request',
        owner: '@acceptance/crashing',
        name: 'lateOldGeneration',
        handlerId: 'handler-9007199254740990',
        location: 'server',
      },
    }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      appendFileSync(staleMarkerPath, `${staleGeneration}->${generation}\n`);
      resolve();
    });
  });
}

function readLateAttempts(markerPath) {
  try {
    return readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}
