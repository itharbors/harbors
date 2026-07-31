function requireMethod(value, method, context) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${context}.${method} is required`);
  }
}

const reopenedOperations = new WeakSet();

export async function restoreLiveKitDeactivation(
  operation,
  { store, openWindow, isQuitting },
) {
  const record = (await store.snapshot()).kits[operation.id];
  if (record && record.active === undefined) {
    await store.activate(operation.id, operation.version);
  }
  if (
    operation.reopenOnFailure
    && !reopenedOperations.has(operation)
    && !isQuitting()
  ) {
    await openWindow(operation.id);
    reopenedOperations.add(operation);
  }
}

export function createLiveKitDeactivation({
  store,
  closeWindow,
  replaceFramework,
  openWindow,
  isQuitting,
}) {
  for (const method of ['snapshot', 'activate', 'deactivate']) {
    requireMethod(store, method, 'store');
  }
  for (const [name, value] of Object.entries({
    closeWindow,
    replaceFramework,
    openWindow,
    isQuitting,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }

  return async function applyLiveKitDeactivation(id) {
    const { version } = await store.deactivate(id);
    const operation = {
      kind: 'deactivation',
      id,
      version,
      reopenOnFailure: closeWindow(id),
    };
    try {
      await replaceFramework(operation);
    } catch (error) {
      await restoreLiveKitDeactivation(operation, { store, openWindow, isQuitting });
      throw error;
    }
    return { id, version, runtimeReloaded: true };
  };
}
