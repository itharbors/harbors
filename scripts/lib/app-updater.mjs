import { spawnSync } from 'node:child_process';
import semver from 'semver';

const UPDATE_FAILED = Object.freeze({
  code: 'UPDATE_FAILED',
  message: 'Unable to update ITHARBORS',
});
const UPDATE_ACTION_INVALID = Object.freeze({
  code: 'UPDATE_ACTION_INVALID',
  message: 'This update action is not available',
});
function publicError({ code, message }) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function freezeSnapshot({
  status,
  currentVersion,
  availableVersion = null,
  progress = null,
  error = null,
}) {
  return Object.freeze({
    status,
    currentVersion,
    availableVersion,
    progress,
    error: error ? Object.freeze({ ...error }) : null,
  });
}

function validatedVersion(value, allowPrerelease) {
  if (typeof value !== 'string' || semver.valid(value) !== value) return null;
  if (!allowPrerelease && semver.prerelease(value) !== null) return null;
  return value;
}

export function appUpdatesDisabled(value) {
  return value === '1';
}

export function hasOfficialMacSignature({
  isPackaged,
  platform = process.platform,
  executable = process.execPath,
  runCodesign = spawnSync,
}) {
  if (!isPackaged || platform !== 'darwin' || typeof executable !== 'string' || !executable) {
    return false;
  }
  try {
    const options = { encoding: 'utf8', windowsHide: true };
    const verified = runCodesign(
      '/usr/bin/codesign',
      ['--verify', '--strict', executable],
      options,
    );
    if (verified?.status !== 0) return false;
    const inspected = runCodesign(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', executable],
      options,
    );
    if (inspected?.status !== 0) return false;
    const details = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
    return /^Authority=Developer ID Application:.+$/mu.test(details)
      && /^TeamIdentifier=(?!not set$)\S+$/mu.test(details);
  } catch {
    return false;
  }
}

export function createAppUpdater({
  updater,
  currentVersion,
  isPackaged,
  releaseSigned = false,
  updatesDisabled = false,
  onInstall,
}) {
  if (semver.valid(currentVersion) !== currentVersion) {
    throw publicError(UPDATE_FAILED);
  }
  if (!updater || typeof updater !== 'object' || typeof onInstall !== 'function') {
    throw new TypeError('App updater requires provider and install adapters');
  }

  const listeners = new Set();
  const providerListeners = new Map();
  const pendingNotifications = [];
  const allowPrerelease = semver.prerelease(currentVersion) !== null;
  let disposed = false;
  let notifying = false;
  let checkPromise = null;
  let downloadPromise = null;
  const disabled = !isPackaged || !releaseSigned || updatesDisabled === true;
  let snapshot = freezeSnapshot({
    status: disabled ? 'disabled' : 'idle',
    currentVersion,
  });

  function publish(next) {
    if (disposed) return snapshot;
    const published = freezeSnapshot({ currentVersion, ...next });
    snapshot = published;
    pendingNotifications.push(published);
    if (notifying) return published;
    notifying = true;
    try {
      while (pendingNotifications.length > 0) {
        const notification = pendingNotifications.shift();
        for (const listener of listeners) {
          try {
            listener(notification);
          } catch {
            // A renderer observer cannot interrupt the update transaction.
          }
        }
      }
    } finally {
      notifying = false;
    }
    return published;
  }

  function fail(retainCandidate = false) {
    return publish({
      status: 'error',
      availableVersion: retainCandidate ? snapshot.availableVersion : null,
      progress: null,
      error: UPDATE_FAILED,
    });
  }

  function invalidAction() {
    return Promise.reject(publicError(UPDATE_ACTION_INVALID));
  }

  function runProvider(operation, expectedStatus) {
    let result;
    try {
      result = operation();
    } catch {
      if (snapshot.status === expectedStatus) fail(expectedStatus === 'downloading');
      return Promise.reject(publicError(UPDATE_FAILED));
    }
    return Promise.resolve(result).catch(() => {
      if (snapshot.status === expectedStatus) fail(expectedStatus === 'downloading');
      throw publicError(UPDATE_FAILED);
    });
  }

  function check() {
    if (disposed) return invalidAction();
    if (snapshot.status === 'checking') return checkPromise;
    if (!['idle', 'not-available', 'error'].includes(snapshot.status)) {
      return invalidAction();
    }
    publish({ status: 'checking' });
    checkPromise = runProvider(() => updater.checkForUpdates(), 'checking');
    return checkPromise;
  }

  function download() {
    if (snapshot.status === 'downloading') return downloadPromise;
    if (
      disposed
      || !['available', 'error'].includes(snapshot.status)
      || !snapshot.availableVersion
    ) return invalidAction();
    publish({
      status: 'downloading',
      availableVersion: snapshot.availableVersion,
      progress: null,
    });
    downloadPromise = runProvider(() => updater.downloadUpdate(), 'downloading');
    return downloadPromise;
  }

  function install() {
    if (disposed || snapshot.status !== 'downloaded') return invalidAction();
    publish({
      status: 'installing',
      availableVersion: snapshot.availableVersion,
      progress: snapshot.progress,
    });
    let result;
    try {
      result = onInstall();
    } catch {
      return Promise.reject(publicError(UPDATE_FAILED));
    }
    return Promise.resolve(result).catch(() => {
      throw publicError(UPDATE_FAILED);
    });
  }

  function onUpdateAvailable(info) {
    if (snapshot.status !== 'checking') return;
    const version = validatedVersion(info?.version, allowPrerelease);
    if (!version) {
      fail(false);
      return;
    }
    publish({ status: 'available', availableVersion: version });
  }

  function onUpdateNotAvailable() {
    if (snapshot.status !== 'checking') return;
    publish({ status: 'not-available' });
  }

  function onDownloadProgress(info) {
    if (snapshot.status !== 'downloading') return;
    const percent = Number(info?.percent);
    if (!Number.isFinite(percent)) return;
    publish({
      status: 'downloading',
      availableVersion: snapshot.availableVersion,
      progress: Math.min(100, Math.max(0, percent)),
    });
  }

  function onUpdateDownloaded(info) {
    if (snapshot.status !== 'downloading') return;
    const version = validatedVersion(info?.version, allowPrerelease);
    if (!version) {
      fail(true);
      return;
    }
    publish({
      status: 'downloaded',
      availableVersion: version,
      progress: 100,
    });
  }

  function onProviderError() {
    if (snapshot.status === 'installing') return;
    fail(
      ['available', 'downloading'].includes(snapshot.status)
      || (snapshot.status === 'error' && Boolean(snapshot.availableVersion)),
    );
  }

  if (!disabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = allowPrerelease;
    providerListeners.set('update-available', onUpdateAvailable);
    providerListeners.set('update-not-available', onUpdateNotAvailable);
    providerListeners.set('download-progress', onDownloadProgress);
    providerListeners.set('update-downloaded', onUpdateDownloaded);
    providerListeners.set('error', onProviderError);
    for (const [event, listener] of providerListeners) updater.on(event, listener);
  }

  return Object.freeze({
    check,
    download,
    install,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function' || disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return snapshot;
      disposed = true;
      for (const [event, listener] of providerListeners) updater.removeListener(event, listener);
      providerListeners.clear();
      listeners.clear();
      return snapshot;
    },
  });
}
