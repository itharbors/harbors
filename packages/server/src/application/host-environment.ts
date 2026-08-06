export const APPLICATION_HOST_SECRET_ENVIRONMENT_KEYS = Object.freeze([
  'HARBORS_APPLICATION_TOKEN',
  'HARBORS_NOTIFICATION_PORT',
] as const);

export function captureApplicationHostSecrets(env: NodeJS.ProcessEnv): {
  applicationControlToken?: string;
  notificationPort?: number;
} {
  const applicationControlToken = env.HARBORS_APPLICATION_TOKEN;
  const rawPort = env.HARBORS_NOTIFICATION_PORT;
  for (const key of APPLICATION_HOST_SECRET_ENVIRONMENT_KEYS) delete env[key];
  return {
    applicationControlToken,
    notificationPort: rawPort ? Number(rawPort) : undefined,
  };
}
