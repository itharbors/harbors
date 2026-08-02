import { realpath } from 'node:fs/promises';
import path from 'node:path';

function requireMethod(value, method, context) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${context}.${method} is required`);
  }
}

async function safeAudit(audit, entry) {
  await audit.append(entry).catch(() => undefined);
}

function kitAuditIdentity(id, version, channel) {
  return { id, version, channel };
}

function runtimeFailure(error) {
  const rawMessage = error instanceof Error ? error.message : '';
  const message = rawMessage
    .replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240) || 'Kit runtime validation failed';
  return { code: 'RUNTIME_LOAD_FAILED', message };
}

async function canonicalDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('Installed Kit directory is required');
  }
  try {
    return await realpath(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return path.resolve(directory);
    throw error;
  }
}

async function bindInstalledSelection(selection, activeSources, catalog) {
  if (!Array.isArray(activeSources)) throw new TypeError('active sources must be an array');
  if (!Array.isArray(catalog)) throw new TypeError('validated Catalog must be an array');
  const activeSource = activeSources.find((entry) => (
    entry?.id === selection.id
    && entry.version === selection.version
    && entry.source === 'installed'
  ));
  if (!activeSource) {
    throw new Error(`Installed Kit ${selection.id}@${selection.version} is absent from active sources`);
  }
  const expectedDirectory = await canonicalDirectory(activeSource.directory);
  for (const entry of catalog) {
    if (entry?.name !== selection.id
      || entry.version !== selection.version
      || entry.source !== 'installed') continue;
    if (await canonicalDirectory(entry.directory) === expectedDirectory) {
      return {
        ...selection,
        source: 'installed',
        directory: expectedDirectory,
      };
    }
  }
  throw new Error(`Installed Kit ${selection.id}@${selection.version} is absent from the resolved Catalog`);
}

export async function prepareInstalledKitsForStartup({ store, validateCatalog, audit }) {
  for (const method of ['snapshot', 'stageActivation', 'failActivation', 'listActiveSources']) {
    requireMethod(store, method, 'store');
  }
  if (typeof validateCatalog !== 'function') throw new TypeError('validateCatalog is required');
  requireMethod(audit, 'append', 'audit');

  const initial = await store.snapshot();
  const pendingUninstalls = Object.entries(initial.kits)
    .filter(([, record]) => record.pendingUninstall === true)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id]) => ({ id }));
  const pending = Object.entries(initial.kits)
    .filter(([, record]) => record.pending !== undefined && !record.pendingUninstall)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record]) => ({ id, version: record.pending, channel: record.channel }));
  const outcomes = [];
  const pendingActivations = [];

  for (const selection of pending) {
    const kit = kitAuditIdentity(selection.id, selection.version, selection.channel);
    await store.stageActivation(selection.id, selection.version);
    try {
      const activeSources = await store.listActiveSources();
      const catalog = await validateCatalog(activeSources);
      pendingActivations.push(await bindInstalledSelection(selection, activeSources, catalog));
      outcomes.push({ id: selection.id, version: selection.version, status: 'pending-runtime' });
      continue;
    } catch {
      const failure = await store.failActivation(selection.id, selection.version);
      await safeAudit(audit, {
        event: 'kit.activate', outcome: 'failure', source: 'local', kit, code: 'CATALOG_INVALID',
      });
      if (failure.status === 'recovery-pending') {
        const recovery = {
          id: selection.id,
          version: failure.recoveryVersion,
          channel: selection.channel,
        };
        try {
          await store.stageActivation(recovery.id, recovery.version);
          const activeSources = await store.listActiveSources();
          const catalog = await validateCatalog(activeSources);
          pendingActivations.push(await bindInstalledSelection(recovery, activeSources, catalog));
          await safeAudit(audit, {
            event: 'kit.rollback', outcome: 'success', source: 'local',
            kit: kitAuditIdentity(selection.id, recovery.version, selection.channel),
          });
          outcomes.push({ id: selection.id, version: selection.version, status: 'recovery-pending' });
          continue;
        } catch {
          await store.failActivation(recovery.id, recovery.version);
          await safeAudit(audit, {
            event: 'kit.activate', outcome: 'failure', source: 'local',
            kit: kitAuditIdentity(recovery.id, recovery.version, recovery.channel),
            code: 'CATALOG_INVALID',
          });
        }
      }
      await safeAudit(audit, {
        event: 'kit.rollback', outcome: 'failure', source: 'local', kit,
        code: failure.status === 'disabled' ? 'NO_PREVIOUS' : 'CATALOG_INVALID',
      });
      outcomes.push({ id: selection.id, version: selection.version, status: 'disabled' });
    }
  }

  return {
    activeSources: await store.listActiveSources(),
    outcomes,
    pendingActivations,
    pendingUninstalls,
  };
}

export async function finalizePendingKitActivations({
  store,
  selections,
  catalog,
  validateRuntime,
  audit,
}) {
  for (const method of ['commitActivation', 'failActivation']) {
    requireMethod(store, method, 'store');
  }
  if (!Array.isArray(selections)) throw new TypeError('selections must be an array');
  if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array');
  if (typeof validateRuntime !== 'function') throw new TypeError('validateRuntime is required');
  requireMethod(audit, 'append', 'audit');

  const outcomes = [];
  for (const selection of selections) {
    const kit = kitAuditIdentity(selection.id, selection.version, selection.channel);
    try {
      const exactSelection = await bindInstalledSelection(selection, [selection], catalog);
      await validateRuntime(exactSelection);
    } catch (error) {
      const failureDetail = runtimeFailure(error);
      const failure = await store.failActivation(selection.id, selection.version);
      await safeAudit(audit, {
        event: 'kit.activate', outcome: 'failure', source: 'local', kit,
        code: 'RUNTIME_LOAD_FAILED',
      });
      if (failure.status === 'recovery-pending') {
        await safeAudit(audit, {
          event: 'kit.rollback', outcome: 'success', source: 'local',
          kit: kitAuditIdentity(selection.id, failure.recoveryVersion, selection.channel),
        });
        outcomes.push({
          id: selection.id,
          version: selection.version,
          status: 'recovery-pending',
          error: failureDetail,
        });
      } else {
        await safeAudit(audit, {
          event: 'kit.rollback', outcome: 'failure', source: 'local', kit,
          code: 'NO_PREVIOUS',
        });
        outcomes.push({
          id: selection.id,
          version: selection.version,
          status: 'disabled',
          error: failureDetail,
        });
      }
      continue;
    }

    await store.commitActivation(selection.id, selection.version);
    await safeAudit(audit, { event: 'kit.activate', outcome: 'success', source: 'local', kit });
    outcomes.push({ id: selection.id, version: selection.version, status: 'activated' });
  }

  return {
    outcomes,
    restartRequired: outcomes.some((outcome) => outcome.status !== 'activated'),
  };
}
