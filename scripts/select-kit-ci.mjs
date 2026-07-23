#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { selectKitSlugs } from './lib/kit-ci-selection.mjs';
import { loadKitPolicy } from './lib/kit-monorepo.mjs';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const USAGE = 'Usage: node scripts/select-kit-ci.mjs <base-sha> <head-sha>\n';
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

async function runGit(args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: process.cwd(),
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new Error('Git diff failed', { cause: error });
  }
}

function parseNulTerminatedPaths(output) {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error('Git diff output is invalid');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch (error) {
    throw new Error('Changed path must be a canonical repository path', { cause: error });
  }
  return decoded.slice(0, -1).split('\0');
}

async function baseIsRootCommit(baseSha) {
  const output = await runGit(['rev-list', '--parents', '--max-count=1', baseSha]);
  return output.toString('ascii').trim() === baseSha;
}

async function changedPaths(baseSha, headSha) {
  const outputs = [await runGit([
    'diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=ACDMR',
    '-z',
    baseSha,
    headSha,
    '--',
  ])];
  if (await baseIsRootCommit(baseSha)) {
    outputs.push(await runGit([
      'diff-tree',
      '--root',
      '-r',
      '--no-renames',
      '--no-commit-id',
      '--name-only',
      '--diff-filter=ACDMR',
      '-z',
      baseSha,
      '--',
    ]));
  }
  return [...new Set(outputs.flatMap(parseNulTerminatedPaths))];
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim()
    || 'Kit CI selection failed';
}

async function main(args) {
  if (args.length !== 2 || args.some((value) => !SHA_PATTERN.test(value))) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const slugs = selectKitSlugs(await changedPaths(args[0], args[1]));
    const policy = slugs.length === 0
      ? null
      : await loadKitPolicy({ repositoryRoot: process.cwd() });
    const matrix = {
      include: slugs.map((kit) => ({ kit, runner: policy.kits[kit].runner })),
    };
    process.stdout.write(`MATRIX_JSON=${JSON.stringify(matrix)}\n`);
    process.stdout.write(`HAS_KITS=${slugs.length > 0}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR=${safeErrorMessage(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
