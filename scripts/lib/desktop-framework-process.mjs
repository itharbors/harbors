import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function isLive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function removeListener(emitter, event, listener) {
  emitter.off?.(event, listener);
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function createPackagedFrameworkSpec({ executable, frameworkEntry, env }) {
  const command = requireAbsolute(executable, 'executable');
  const entry = requireAbsolute(frameworkEntry, 'frameworkEntry');
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }
  return Object.freeze({
    command,
    args: Object.freeze([entry]),
    env: Object.freeze({ ...env, ELECTRON_RUN_AS_NODE: '1' }),
    stdio: Object.freeze(['ignore', 'inherit', 'inherit', 'ipc']),
  });
}

export function startDesktopFrameworkProcess(spec, {
  spawn = spawnChild,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  startTimeoutMs = START_TIMEOUT_MS,
  stopTimeoutMs = STOP_TIMEOUT_MS,
} = {}) {
  const child = spawn(spec.command, spec.args, {
    env: spec.env,
    stdio: spec.stdio,
  });
  let startupTimer;
  let startupSettled = false;
  let stopPromise;
  let resolveReady;
  let rejectReady;

  const cleanupStartup = () => {
    if (startupTimer) cancelSchedule(startupTimer);
    removeListener(child, 'message', onMessage);
    removeListener(child, 'exit', onExit);
    removeListener(child, 'error', onError);
  };
  const settleStartup = (result, value) => {
    if (startupSettled) return;
    startupSettled = true;
    cleanupStartup();
    result(value);
  };
  const onMessage = (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      if (!validPort(message.port)) {
        settleStartup(rejectReady, new Error('Framework sent an invalid ready port'));
        return;
      }
      settleStartup(resolveReady, Object.freeze({
        child,
        startUrl: `http://127.0.0.1:${message.port}/`,
      }));
      return;
    }
    if (message.type === 'fatal') {
      const detail = typeof message.message === 'string' && message.message
        ? message.message
        : 'Framework reported a fatal startup error';
      settleStartup(rejectReady, new Error(detail));
    }
  };
  const onExit = (code, signal) => {
    settleStartup(rejectReady, new Error(
      `Framework exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
    ));
  };
  const onError = (error) => {
    settleStartup(rejectReady, error instanceof Error ? error : new Error(String(error)));
  };
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('error', onError);
  startupTimer = schedule(() => {
    if (isLive(child)) child.kill('SIGKILL');
    settleStartup(rejectReady, new Error('Timed out waiting for Framework ready message'));
  }, startTimeoutMs);

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = new Promise((resolve) => {
      if (!isLive(child)) {
        resolve();
        return;
      }
      let forceStopTimer;
      const finish = () => {
        if (forceStopTimer) cancelSchedule(forceStopTimer);
        removeListener(child, 'exit', finish);
        resolve();
      };
      child.once('exit', finish);
      try {
        child.send({ type: 'shutdown' });
      } catch {
        // The timeout below guarantees a stopped child even when IPC is already unavailable.
      }
      forceStopTimer = schedule(() => {
        if (isLive(child)) child.kill('SIGKILL');
      }, stopTimeoutMs);
    });
    return stopPromise;
  };

  return Object.freeze({ child, ready, stop });
}
