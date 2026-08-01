import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CodexSkillInstallError,
  createCodexSkillInstaller,
  type CodexSkillInstallResult,
} from './codex-skill-installer.js';

declare const editor: any;

let skillInstaller: ReturnType<typeof createCodexSkillInstaller> | null = null;
let applicationHostMode: 'desktop' | 'web' = 'web';
let notifications: any;

editor.plugin.define({
  lifecycle: {
    load(runtime: { host: { mode: 'desktop' | 'web'; notifications: any } }) {
      skillInstaller = null;
      applicationHostMode = runtime.host.mode;
      notifications = runtime.host.mode === 'desktop' ? runtime.host.notifications : null;
    },
  },
  methods: {
    getSnapshot: () => requireNotifications().list(),
    markRead: (id: string) => requireNotifications().markRead(id),
    markAllRead: () => requireNotifications().markAllRead(),
    removeNotification: (id: string) => requireNotifications().remove(id),
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
  const sourceDir = resolveBundledSkillSource();
  if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
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

function resolveBundledSkillSource(): string {
  return fileURLToPath(new URL('./resources/notify-user', import.meta.url));
}

async function sendInstallResultNotification(
  result: CodexSkillInstallResult | SkillInstallFailure,
) {
  await requireNotifications().create(installResultNotification(result));
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

function requireNotifications() {
  if (!notifications) throw new Error('Desktop notification service is unavailable');
  return notifications;
}
