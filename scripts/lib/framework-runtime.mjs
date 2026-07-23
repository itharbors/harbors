import { execFileSync as executeFileSync } from 'node:child_process';

const RUNTIME_EXPRESSION = `JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
})`;

function parseRuntime(value) {
  let runtime;
  try {
    runtime = JSON.parse(value);
  } catch (error) {
    throw new Error('Framework Node runtime returned invalid JSON', { cause: error });
  }
  if (
    !runtime
    || typeof runtime !== 'object'
    || Array.isArray(runtime)
    || Object.keys(runtime).length !== 3
    || typeof runtime.platform !== 'string'
    || !/^[a-z0-9_-]+$/u.test(runtime.platform)
    || typeof runtime.arch !== 'string'
    || !/^[a-z0-9_-]+$/u.test(runtime.arch)
    || typeof runtime.nodeAbi !== 'string'
    || !/^[1-9][0-9]*$/u.test(runtime.nodeAbi)
  ) {
    throw new Error('Framework Node runtime identity is invalid');
  }
  return Object.freeze({
    platform: runtime.platform,
    arch: runtime.arch,
    nodeAbi: runtime.nodeAbi,
  });
}

export function resolveFrameworkRuntime({
  env = process.env,
  execFileSync = executeFileSync,
} = {}) {
  const nodeExecutable = typeof env.npm_node_execpath === 'string' && env.npm_node_execpath
    ? env.npm_node_execpath
    : 'node';
  const output = execFileSync(nodeExecutable, ['-p', RUNTIME_EXPRESSION], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
    shell: false,
    windowsHide: true,
  });
  return parseRuntime(output);
}
