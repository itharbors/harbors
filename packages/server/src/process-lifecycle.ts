export interface ProcessSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function registerServerShutdown(
  stop: () => Promise<void>,
  signalSource: ProcessSignalSource = process,
  onError: (error: unknown) => void = (error) => {
    console.error('Failed to stop Editor server:', error);
    process.exitCode = 1;
  },
): () => void {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise) return;
    shutdownPromise = Promise.resolve()
      .then(stop)
      .catch(onError);
  };

  signalSource.once('SIGINT', shutdown);
  signalSource.once('SIGTERM', shutdown);

  return () => {
    signalSource.off('SIGINT', shutdown);
    signalSource.off('SIGTERM', shutdown);
  };
}

export async function startServerUntilShutdown(
  start: () => Promise<number>,
  stop: () => Promise<void>,
  signalSource: ProcessSignalSource = process,
  onError?: (error: unknown) => void,
): Promise<number | undefined> {
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | undefined;
  const stopForSignal = () => {
    shutdownRequested = true;
    if (!shutdownPromise) shutdownPromise = Promise.resolve().then(stop);
    return shutdownPromise;
  };
  if (onError) {
    registerServerShutdown(stopForSignal, signalSource, onError);
  } else {
    registerServerShutdown(stopForSignal, signalSource);
  }

  try {
    return await start();
  } catch (error) {
    if (!shutdownRequested) throw error;
    await shutdownPromise;
    return undefined;
  }
}
