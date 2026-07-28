function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`Kit runtime adapter ${method} is required`);
  }
}

export function createKitRuntimeCoordinator(adapters) {
  requireMethod(adapters, 'applyActivation');
  requireMethod(adapters, 'applyUninstall');
  let tail = Promise.resolve();
  let disposing = false;

  function enqueue(operation) {
    if (disposing) return Promise.reject(new Error('Kit runtime is shutting down'));
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    applyActivation(selection) {
      return enqueue(() => adapters.applyActivation(selection));
    },
    applyUninstall(id) {
      return enqueue(() => adapters.applyUninstall(id));
    },
    drain() {
      return tail;
    },
    dispose() {
      disposing = true;
      return tail;
    },
  });
}
