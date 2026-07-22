import os from 'node:os';
import path from 'node:path';

import {
  CodexSkillInstallError,
  createCodexSkillInstaller,
  type CodexSkillInstallResult,
} from './codex-skill-installer.js';

declare const editor: any;

const DEFAULT_NOTIFICATION_PORT = 48383;
let skillInstaller: ReturnType<typeof createCodexSkillInstaller> | null = null;
let applicationHostMode: 'desktop' | 'web' = 'web';

editor.plugin.define({
  lifecycle: {
    load(runtime: { host: { mode: 'desktop' | 'web' } }) {
      skillInstaller = null;
      applicationHostMode = runtime.host.mode;
    },
  },
  methods: {
    async installCodexSkill() {
      let result: CodexSkillInstallResult | SkillInstallFailure;
      try {
        result = await getSkillInstaller().install();
      } catch (error) {
        result = normalizeInstallFailure(error);
      }
      if (applicationHostMode === 'desktop') {
        await sendInstallResultNotification(result);
      }
      return result;
    },
  },
});

type SkillInstallFailure = {
  status: 'failed';
  code: string;
  message: string;
};

function getSkillInstaller() {
  if (skillInstaller) return skillInstaller;
  if (applicationHostMode !== 'desktop') {
    throw new CodexSkillInstallError(
      'SKILL_DESKTOP_REQUIRED',
      'Codex Skill installation is available only in Harbors Electron desktop mode',
    );
  }
  const sourceDir = process.env.HARBORS_NOTIFY_SKILL_SOURCE;
  if (!sourceDir || !path.isAbsolute(sourceDir)) {
    throw new CodexSkillInstallError(
      'SKILL_SOURCE_INVALID',
      'Codex Skill installation is available only in Harbors Electron desktop mode',
    );
  }
  const configuredHome = process.env.CODEX_HOME;
  const codexHome = configuredHome && configuredHome.trim().length > 0
    ? configuredHome
    : path.join(os.homedir(), '.codex');
  skillInstaller = createCodexSkillInstaller({ sourceDir, codexHome });
  return skillInstaller;
}

async function sendInstallResultNotification(
  result: CodexSkillInstallResult | SkillInstallFailure,
) {
  await hostRequest('/v1/notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(installResultNotification(result)),
  });
}

function installResultNotification(result: CodexSkillInstallResult | SkillInstallFailure) {
  if (result.status === 'failed') {
    return {
      title: 'Codex notification Skill installation failed',
      body: result.message,
      level: 'error',
      source: 'Harbors',
      persistent: true,
    };
  }
  if (result.status === 'current') {
    return {
      title: 'Codex notification Skill is up to date',
      body: 'The installed notify-user Skill already matches this Harbors version.',
      level: 'info',
      source: 'Harbors',
      persistent: false,
    };
  }
  return {
    title: result.status === 'installed'
      ? 'Codex notification Skill installed'
      : 'Codex notification Skill updated',
    body: 'The notify-user Skill will be available from your next Codex turn.',
    level: 'success',
    source: 'Harbors',
    persistent: false,
  };
}

function normalizeInstallFailure(error: unknown): SkillInstallFailure {
  return {
    status: 'failed',
    code: error instanceof CodexSkillInstallError ? error.code : 'SKILL_INSTALL_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function hostRequest(pathname: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${hostBaseUrl()}${pathname}`, init);
  } catch {
    throw new Error('Desktop notification service is unavailable');
  }
  if (response.status === 204) return undefined;
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(getErrorMessage(payload) ?? `Notification Host returned HTTP ${response.status}`);
  }
  return payload;
}

function hostBaseUrl(): string {
  const rawPort = process.env.HARBORS_NOTIFICATION_PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_NOTIFICATION_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HARBORS_NOTIFICATION_PORT must be an integer between 1 and 65535');
  }
  return `http://127.0.0.1:${port}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Notification Host returned invalid JSON');
  }
}

function getErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
