export function createNpmSpawnSpec(args, {
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (env.npm_execpath) {
    return {
      command: execPath,
      args: [env.npm_execpath, ...args],
      spawnOptions: {},
    };
  }

  if (platform === 'win32') {
    return {
      command: 'npm.cmd',
      args,
      spawnOptions: { shell: true },
    };
  }

  return {
    command: 'npm',
    args,
    spawnOptions: {},
  };
}
