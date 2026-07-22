export function createNpmSpawnSpec(args, {
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (env.npm_execpath) {
    return {
      command: typeof env.npm_node_execpath === 'string' && env.npm_node_execpath
        ? env.npm_node_execpath
        : execPath,
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
