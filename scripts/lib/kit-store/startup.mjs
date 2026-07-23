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

export async function prepareInstalledKitsForStartup({ store, validateCatalog, audit }) {
  for (const method of ['snapshot', 'stageActivation', 'failActivation', 'listActiveSources']) {
    requireMethod(store, method, 'store');
  }
  if (typeof validateCatalog !== 'function') throw new TypeError('validateCatalog is required');
  requireMethod(audit, 'append', 'audit');

  const initial = await store.snapshot();
  const pending = Object.entries(initial.kits)
    .filter(([, record]) => record.pending !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record]) => ({ id, version: record.pending, channel: record.channel }));
  const outcomes = [];
  const pendingActivations = [];

  for (const selection of pending) {
    const kit = kitAuditIdentity(selection.id, selection.version, selection.channel);
    await store.stageActivation(selection.id, selection.version);
    try {
      await validateCatalog(await store.listActiveSources());
      pendingActivations.push(selection);
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
          await validateCatalog(await store.listActiveSources());
          pendingActivations.push(recovery);
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

  return { activeSources: await store.listActiveSources(), outcomes, pendingActivations };
}

export async function finalizePendingKitActivations({
  store,
  selections,
  validateRuntime,
  audit,
}) {
  for (const method of ['commitActivation', 'failActivation']) {
    requireMethod(store, method, 'store');
  }
  if (!Array.isArray(selections)) throw new TypeError('selections must be an array');
  if (typeof validateRuntime !== 'function') throw new TypeError('validateRuntime is required');
  requireMethod(audit, 'append', 'audit');

  const outcomes = [];
  for (const selection of selections) {
    const kit = kitAuditIdentity(selection.id, selection.version, selection.channel);
    try {
      await validateRuntime(selection);
    } catch {
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
        outcomes.push({ id: selection.id, version: selection.version, status: 'recovery-pending' });
      } else {
        await safeAudit(audit, {
          event: 'kit.rollback', outcome: 'failure', source: 'local', kit,
          code: 'NO_PREVIOUS',
        });
        outcomes.push({ id: selection.id, version: selection.version, status: 'disabled' });
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
