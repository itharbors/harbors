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
