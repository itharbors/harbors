#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createKitReleasePlan } from './lib/kit-release-intent.mjs';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const USAGE = 'Usage: node scripts/plan-kit-releases.mjs <base-sha> <head-sha>\n';
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

async function git(args, encoding = 'buffer') {
  const { stdout } = await execFileAsync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

function parseChangedPaths(output) {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error('Git diff output is invalid');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch (error) {
    throw new Error('Changed path must be a canonical repository path', { cause: error });
  }
  return text.slice(0, -1).split('\0');
}

async function readJsonAt(sha, relative, optional = false) {
  let text;
  try {
    text = await git(['show', `${sha}:${relative}`], 'utf8');
  } catch (error) {
    if (optional) return undefined;
    throw new Error(`${relative} is missing at ${sha}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relative} must contain valid JSON at ${sha}`, { cause: error });
  }
}

async function productAt(sha, slug, optional = false) {
  const prefix = `kits/${slug}`;
  const [manifest, packageJson, lockfile] = await Promise.all([
    readJsonAt(sha, `${prefix}/kit.json`, optional),
    readJsonAt(sha, `${prefix}/package.json`, optional),
    readJsonAt(sha, `${prefix}/package-lock.json`, optional),
  ]);
  const present = [manifest, packageJson, lockfile].filter((value) => value !== undefined).length;
  if (present === 0 && optional) return undefined;
  if (present !== 3) throw new Error(`Base Kit snapshot for ${slug} is partial`);
  return { manifest, packageJson, lockfile };
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')
    .trim() || 'Kit release intent planning failed';
}

async function main(args) {
  if (args.length !== 2 || args.some((value) => !SHA_PATTERN.test(value))) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [baseSha, headSha] = args;
  try {
    await Promise.all([
      git(['cat-file', '-e', `${baseSha}^{commit}`]),
      git(['cat-file', '-e', `${headSha}^{commit}`]),
    ]);
    const changedPaths = parseChangedPaths(await git([
      'diff', '--no-renames', '--name-only', '--diff-filter=ACDMR', '-z', baseSha, headSha, '--',
    ]));
    const policy = await readJsonAt(headSha, 'registry/policy.json');
    const policySlugs = new Set(Object.keys(policy?.kits ?? {}));
    const changedSlugs = [...new Set(changedPaths
      .map((value) => value.split('/'))
      .filter((parts) => parts[0] === 'kits' && parts.length > 2 && policySlugs.has(parts[1]))
      .map((parts) => parts[1]))].sort();
    const baseProducts = new Map();
    const headProducts = new Map();
    for (const slug of changedSlugs) {
      const [base, head] = await Promise.all([
        productAt(baseSha, slug, true),
        productAt(headSha, slug),
      ]);
      if (base) baseProducts.set(slug, base);
      headProducts.set(slug, head);
    }
    const plan = createKitReleasePlan({ changedPaths, policy, baseProducts, headProducts });
    process.stdout.write(`RELEASES_JSON=${JSON.stringify(plan)}\nHAS_RELEASES=${plan.length > 0}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR=${safeMessage(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
