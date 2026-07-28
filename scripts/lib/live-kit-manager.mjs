const KIT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function requireMethod(value, method, context) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${context}.${method} is required`);
  }
}

function kitId(value) {
  if (typeof value !== 'string' || !KIT_ID_PATTERN.test(value)) {
    throw new Error('Kit id must be a lowercase scoped package id');
  }
  return value;
}

function liveResult(value, { includePending = true } = {}) {
  return {
    ...value,
    ...(includePending ? { pending: false } : {}),
    requiresRestart: false,
    runtimeReloaded: value.runtimeReloaded === true,
  };
}

export function createLiveKitManager({ manager, coordinator, builtinKitIds = [] }) {
  for (const method of ['list', 'refresh', 'install']) requireMethod(manager, method, 'manager');
  for (const method of ['applyActivation', 'applyUninstall']) {
    requireMethod(coordinator, method, 'coordinator');
  }
  if (!Array.isArray(builtinKitIds)) throw new TypeError('builtinKitIds must be an array');
  const builtin = new Set(builtinKitIds);

  return Object.freeze({
    list: () => manager.list(),
    refresh: () => manager.refresh(),
    async install(value) {
      const installed = await manager.install(value);
      const applied = await coordinator.applyActivation({
        id: installed.id,
        version: installed.version,
        retryBad: false,
      });
      return liveResult({ ...installed, ...applied });
    },
    async activate(value) {
      return liveResult(await coordinator.applyActivation(value));
    },
    async rollback(value) {
      const id = kitId(value);
      return liveResult(await coordinator.applyActivation({ id, rollback: true }));
    },
    async uninstall(value) {
      const id = kitId(value);
      if (builtin.has(id)) throw new Error(`Kit ${id} is built into Harbors`);
      return liveResult(await coordinator.applyUninstall(id), { includePending: false });
    },
  });
}
