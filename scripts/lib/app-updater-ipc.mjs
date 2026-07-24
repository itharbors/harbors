export const APP_UPDATE_CHANNELS = Object.freeze({
  getState: 'harbors:update:get-state',
  check: 'harbors:update:check',
  download: 'harbors:update:download',
  install: 'harbors:update:install',
  state: 'harbors:update:state',
});

function publicSnapshot(snapshot) {
  const error = snapshot?.error
    ? Object.freeze({ code: 'UPDATE_FAILED', message: 'Unable to update ITHARBORS' })
    : null;
  return Object.freeze({
    status: snapshot?.status,
    currentVersion: snapshot?.currentVersion,
    availableVersion: snapshot?.availableVersion ?? null,
    progress: snapshot?.progress ?? null,
    error,
  });
}

function assertZeroArguments(args) {
  if (args.length !== 0) throw new Error('Update IPC does not accept arguments');
}

function assertLiveApplicationWindow(event, BrowserWindow, getApplicationWindows) {
  const window = BrowserWindow.fromWebContents(event?.sender);
  const applicationWindows = getApplicationWindows();
  if (
    !window
    || window.isDestroyed?.()
    || event?.sender?.isDestroyed?.()
    || !Array.isArray(applicationWindows)
    || !applicationWindows.includes(window)
    || window.webContents !== event.sender
  ) {
    throw new Error('Update IPC requires a live application window');
  }
  return window;
}

export function registerAppUpdaterIpc({
  ipcMain,
  BrowserWindow,
  controller,
  getApplicationWindows,
}) {
  const commands = new Map([
    [APP_UPDATE_CHANNELS.getState, null],
    [APP_UPDATE_CHANNELS.check, () => controller.check()],
    [APP_UPDATE_CHANNELS.download, () => controller.download()],
    [APP_UPDATE_CHANNELS.install, () => controller.install()],
  ]);
  let registered = true;

  for (const [channel, action] of commands) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertZeroArguments(args);
      assertLiveApplicationWindow(event, BrowserWindow, getApplicationWindows);
      if (action) await action();
      return publicSnapshot(controller.getSnapshot());
    });
  }

  const unsubscribe = controller.subscribe((snapshot) => {
    const state = publicSnapshot(snapshot);
    for (const window of getApplicationWindows()) {
      if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) continue;
      window.webContents.send(APP_UPDATE_CHANNELS.state, state);
    }
  });

  return Object.freeze({
    unregister() {
      if (!registered) return;
      registered = false;
      unsubscribe();
      for (const channel of commands.keys()) ipcMain.removeHandler(channel);
    },
  });
}
