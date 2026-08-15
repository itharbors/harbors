#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ACTIONS = new Set(['build', 'test', 'check']);
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const USAGE = 'Usage: node scripts/run-kit-matrix.mjs <build|test|check> [slug...]\n';
const CONTROL_OR_LINE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

function canonicalSlug(value, context) {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw new Error(`${context} must be a canonical Kit slug`);
  }
  return value;
}

function canonicalDirectory(value, context) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${context} must be a canonical absolute path`);
  }
  return value;
}

function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(CONTROL_OR_LINE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Unknown error';
}

export function createKitMatrixPlan({ action, slugs = [], descriptors }) {
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    throw new Error(`Unknown Kit matrix action: ${String(action)}`);
  }
  if (!Array.isArray(slugs)) throw new TypeError('slugs must be an array');
  if (!Array.isArray(descriptors)) throw new TypeError('descriptors must be an array');

  const requested = [];
  const requestedSlugs = new Set();
  for (let index = 0; index < slugs.length; index += 1) {
    const slug = canonicalSlug(slugs[index], `slugs[${index}]`);
    if (requestedSlugs.has(slug)) throw new Error(`slugs contains duplicate slug: ${slug}`);
    requestedSlugs.add(slug);
    requested.push(slug);
  }

  const bySlug = new Map();
  const directories = new Set();
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new Error(`descriptors[${index}] must be a Kit descriptor`);
    }
    const slug = canonicalSlug(descriptor.slug, `descriptors[${index}].slug`);
    const directory = canonicalDirectory(descriptor.directory, `descriptors[${index}].directory`);
    if (bySlug.has(slug)) throw new Error(`descriptors contains duplicate slug: ${slug}`);
    if (directories.has(directory)) {
      throw new Error(`descriptors contains duplicate directory: ${directory}`);
    }
    directories.add(directory);
    bySlug.set(slug, { ...descriptor, slug, directory });
  }

  const selected = requested.length === 0 ? [...bySlug.keys()] : requested;
  return selected.sort().map((slug) => {
    const descriptor = bySlug.get(slug);
    if (!descriptor) throw new Error(`Unknown Kit slug: ${slug}`);
    return { ...descriptor, command: action };
  });
}

async function runWithCleanup(operation, cleanup) {
  let value;
  let operationError;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `${sanitizeErrorMessage(operationError)}; cleanup failed: ${sanitizeErrorMessage(cleanupError)}`,
      );
    }
    throw new Error(`cleanup failed: ${sanitizeErrorMessage(cleanupError)}`, { cause: cleanupError });
  }
  if (operationError) throw operationError;
  return value;
}

export async function runKitMatrix({
  action,
  slugs = [],
  repositoryRoot = process.cwd(),
  descriptors,
  discover = discoverDescriptors,
  cacheRoot = path.join(repositoryRoot, '.cache', 'harbors-kit-installs'),
  ensureInstall = ensureInstallForDescriptor,
  run = execFileAsync,
  makeTempDirectory = (prefix) => mkdtemp(prefix),
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
}) {
  canonicalDirectory(repositoryRoot, 'repositoryRoot');
  await run('npm', [
    'run',
    'build',
    '-w',
    '@itharbors/plugin',
    '-w',
    '@itharbors/plugin-types',
    '-w',
    '@itharbors/kit-core',
    '-w',
    '@itharbors/kit-cli',
    '-w',
    '@itharbors/host-security',
    '-w',
    '@itharbors/server',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  const loaded = descriptors ?? await discover(repositoryRoot, slugs);
  const plan = createKitMatrixPlan({ action, slugs, descriptors: loaded });
  const results = [];
  for (const entry of plan) {
    let install;
    try {
      install = await ensureInstall({ descriptor: entry, cacheRoot });
      await runWithCleanup(async () => {
        const installedEntry = { ...entry, directory: install.installRoot };
        if (action === 'test') {
          await runKitCli(run, repositoryRoot, ['build', installedEntry.directory]);
          await runKitCli(run, repositoryRoot, ['test', installedEntry.directory]);
        } else if (action !== 'check') {
          await runKitCli(run, repositoryRoot, [action, installedEntry.directory]);
        } else {
          await checkKitEntry({
            entry: installedEntry,
            repositoryRoot,
            run,
            makeTempDirectory,
            removeDirectory,
          });
        }
      }, () => removeDirectory(install.runRoot));
      results.push(Object.freeze({ slug: entry.slug, status: 'passed' }));
    } catch (error) {
      results.push(Object.freeze({
        slug: entry.slug,
        status: 'failed',
        error: sanitizeErrorMessage(error),
      }));
    }
  }
  const frozenResults = Object.freeze(results);
  const failures = frozenResults.filter((result) => result.status === 'failed');
  if (failures.length > 0) {
    throw new KitMatrixError(frozenResults, failures);
  }
  return frozenResults;
}

async function ensureInstallForDescriptor(options) {
  const { ensureKitInstall } = await import('./lib/kit-install.mjs');
  return ensureKitInstall(options);
}

async function discoverDescriptors(repositoryRoot, slugs) {
  const { discoverRepositoryKits, loadRepositoryKit } = await import('./lib/repository-kits.mjs');
  if (slugs.length > 0) {
    return Promise.all(slugs.map((slug) => loadRepositoryKit({ repositoryRoot, slug })));
  }
  return discoverRepositoryKits({ repositoryRoot });
}

async function checkKitEntry({
  entry,
  repositoryRoot,
  run,
  makeTempDirectory,
  removeDirectory,
}) {
  const temporaryDirectory = await makeTempDirectory(
    path.join(tmpdir(), `harbors-kit-check-${entry.slug}-`),
  );
  await runWithCleanup(async () => {
    const artifact = path.join(temporaryDirectory, `${entry.slug}.hkit`);
    await runKitCli(run, repositoryRoot, ['build', entry.directory]);
    await runKitCli(run, repositoryRoot, ['test', entry.directory]);
    await runKitCli(run, repositoryRoot, ['validate', entry.directory]);
    if (entry.distribution === 'market') {
      await runKitCli(run, repositoryRoot, ['pack', entry.directory, '--output', artifact]);
      await runKitCli(run, repositoryRoot, ['inspect', artifact, '--json']);
    }
  }, () => removeDirectory(temporaryDirectory));
}

class KitMatrixError extends Error {
  constructor(results, failures) {
    super(`Kit matrix failed: ${failures.map((failure) => `${failure.slug}: ${failure.error}`).join('; ')}`);
    this.name = 'KitMatrixError';
    this.results = results;
  }
}

function runKitCli(run, repositoryRoot, args) {
  return run(process.execPath, ['packages/kit-cli/dist/cli.js', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

export async function runKitMatrixCli(args, io = process, dependencies = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    io.stderr.write(USAGE);
    return 2;
  }
  const [action, ...slugs] = args;
  if (!ACTIONS.has(action)) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const results = await runKitMatrix({
      action,
      slugs,
      repositoryRoot: dependencies.repositoryRoot ?? process.cwd(),
      descriptors: dependencies.descriptors,
      cacheRoot: dependencies.cacheRoot,
      ensureInstall: dependencies.ensureInstall,
      run: dependencies.run,
      makeTempDirectory: dependencies.makeTempDirectory,
      removeDirectory: dependencies.removeDirectory,
    });
    for (const result of results) io.stdout.write(`KIT=${result.slug} STATUS=${result.status}\n`);
    return 0;
  } catch (error) {
    if (Array.isArray(error?.results)) {
      for (const result of error.results) {
        io.stdout.write(`KIT=${result.slug} STATUS=${result.status}\n`);
      }
    }
    io.stderr.write(`ERROR=${sanitizeErrorMessage(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runKitMatrixCli(process.argv.slice(2));
}
