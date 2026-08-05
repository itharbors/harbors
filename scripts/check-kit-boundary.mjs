#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isValidKitSlug,
  isValidTaskId,
  sanitizeBoundaryError,
  validateKitChange,
} from './lib/kit-boundary.mjs';

const USAGE = 'Usage: node scripts/check-kit-boundary.mjs KIT_SLUG --task TASK_ID --base BASE_COMMIT --head HEAD_COMMIT\n';

export async function runCheckKitBoundaryCli(
  args,
  io = process,
  dependencies = { repositoryRoot: process.cwd(), validateKitChange },
) {
  if (!Array.isArray(args) || args.length !== 7) {
    io.stderr.write(USAGE);
    return 2;
  }
  const [slug, taskFlag, taskId, baseFlag, base, headFlag, head] = args;
  if (
    typeof slug !== 'string'
    || typeof taskFlag !== 'string'
    || typeof taskId !== 'string'
    || typeof baseFlag !== 'string'
    || typeof base !== 'string'
    || typeof headFlag !== 'string'
    || typeof head !== 'string'
    || !isValidKitSlug(slug)
    || !isValidTaskId(taskId)
    || taskFlag !== '--task'
    || baseFlag !== '--base'
    || headFlag !== '--head'
  ) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const { paths } = await dependencies.validateKitChange({
      repositoryRoot: dependencies.repositoryRoot,
      slug,
      taskId,
      base,
      head,
    });
    io.stdout.write(`BOUNDARY_KIT=${slug}\nBOUNDARY_FILES=${paths.length}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`ERROR=${sanitizeBoundaryError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCheckKitBoundaryCli(process.argv.slice(2));
}
