export function captureApplicationHostSecrets(env: NodeJS.ProcessEnv): {
  applicationControlToken?: string;
  notificationPort?: number;
} {
  const applicationControlToken = env.HARBORS_APPLICATION_TOKEN;
  const rawPort = env.HARBORS_NOTIFICATION_PORT;
  delete env.HARBORS_APPLICATION_TOKEN;
  delete env.HARBORS_NOTIFICATION_PORT;
  return {
    applicationControlToken,
    notificationPort: rawPort ? Number(rawPort) : undefined,
  };
}
