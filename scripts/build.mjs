#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCachedTask } from './lib/build-cache.mjs';
import { createBuildPlan } from './lib/build-tasks.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const GRAPH_NAMES = new Set(['all', 'runtime', 'plugins', 'plugins-runtime']);
const USAGE = 'Usage: node scripts/build.mjs <all|runtime|plugins|plugins-runtime> [--force]\n';

export async function runBuild({
  rootDir,
  graphName,
  force = false,
  stdout = process.stdout,
  plan,
}) {
  const resolvedPlan = plan ?? await createBuildPlan(rootDir, graphName);
  const completed = new Map();
  for (const task of resolvedPlan.tasks) {
    const dependencyDigests = [];
    for (const dependency of task.dependencies ?? []) {
      const result = completed.get(dependency);
      if (!result) {
        stdout.write(`FAIL ${task.name}\n`);
        throw new Error(`${task.name} depends on task that has not completed: ${dependency}`);
      }
      dependencyDigests.push(result.resultDigest);
    }
    try {
      const result = await runCachedTask({
        rootDir,
        cacheDir: resolvedPlan.cacheDir,
        task,
        dependencyDigests,
        force,
      });
      completed.set(task.name, result);
      stdout.write(`${result.status === 'hit' ? 'HIT' : 'BUILD'} ${task.name}\n`);
    } catch (error) {
      stdout.write(`FAIL ${task.name}\n`);
      throw error;
    }
  }
  return completed;
}

export async function runBuildCli(
  args,
  io = process,
  dependencies = { createPlan: createBuildPlan, preparePlanner: prepareBuildPlanner },
) {
  const options = parseBuildArgs(args);
  if (!options) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    if (dependencies.preparePlanner) {
      await dependencies.preparePlanner(dependencies.rootDir ?? repositoryRoot);
    }
    await runBuild({
      rootDir: dependencies.rootDir ?? repositoryRoot,
      graphName: options.graphName,
      force: options.force,
      stdout: io.stdout,
      plan: await dependencies.createPlan(dependencies.rootDir ?? repositoryRoot, options.graphName),
    });
    return 0;
  } catch (error) {
    return error?.status ?? 1;
  }
}

async function prepareBuildPlanner(rootDir) {
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', [
      '--filter',
      '@itharbors/kit-core',
      '--filter',
      '@itharbors/kit-cli',
      'run',
      'build',
    ], { cwd: rootDir, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build planner preparation failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}`));
    });
  });
}

function parseBuildArgs(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) return null;
  const [graphName, ...options] = args;
  if (!GRAPH_NAMES.has(graphName) || (options.length === 1 && options[0] !== '--force')) return null;
  return { graphName, force: options.includes('--force') };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runBuildCli(process.argv.slice(2));
}
