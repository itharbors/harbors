#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkOfficialKit } from './lib/kit-check.mjs';
import { OFFICIAL_KIT_SLUGS } from './lib/kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const USAGE = 'Usage: node scripts/check-kit.mjs <sqlite|mysql|notifications> --output-directory <absolute-directory>\n';

function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Unknown error';
}

export async function runCheckKitCli(
  args,
  io = process,
  dependencies = { checkOfficialKit },
) {
  if (!Array.isArray(args) || args.length !== 3) {
    io.stderr.write(USAGE);
    return 2;
  }
  const [slug, option, outputDirectory] = args;
  if (
    typeof slug !== 'string'
    || typeof option !== 'string'
    || typeof outputDirectory !== 'string'
    || !OFFICIAL_KIT_SLUGS.includes(slug)
    || option !== '--output-directory'
    || !path.isAbsolute(outputDirectory)
  ) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const { artifactPath } = await dependencies.checkOfficialKit({
      repositoryRoot,
      slug,
      outputDirectory,
    });
    io.stdout.write(`KIT=${slug}\nARTIFACT=${artifactPath}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`ERROR=${sanitizeErrorMessage(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCheckKitCli(process.argv.slice(2));
}
