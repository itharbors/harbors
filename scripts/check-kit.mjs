#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkOfficialKit } from './lib/kit-check.mjs';
import { OFFICIAL_KIT_SLUGS } from './lib/kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const USAGE = 'Usage: node scripts/check-kit.mjs <sqlite|mysql|notifications> --output-directory <absolute-directory>\n';

export async function runCheckKitCli(
  args,
  io = process,
  dependencies = { checkOfficialKit },
) {
  const [slug, option, outputDirectory] = args;
  if (
    args.length !== 3
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
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`ERROR=${message.replace(/[\r\n]+/gu, ' ')}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCheckKitCli(process.argv.slice(2));
}
