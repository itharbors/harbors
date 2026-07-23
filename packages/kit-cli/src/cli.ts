#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { canonicalJson } from './checksums.js';
import { inspectKit, packKit } from './archive.js';
import { validateKit } from './kit-project.js';

interface CliWriter {
  write(value: string): unknown;
}

export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
}

const USAGE = [
  'Usage:',
  '  harbors-kit validate <kit-directory>',
  '  harbors-kit pack <kit-directory> --output <file.hkit>',
  '  harbors-kit inspect <file.hkit> [--json]',
  '',
].join('\n');

function lines(values: Array<[string, string | number]>): string {
  return `${values.map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function usage(io: CliIo): number {
  io.stderr.write(USAGE);
  return 2;
}

export async function runCli(
  args: string[],
  io: CliIo = process,
): Promise<number> {
  try {
    const [command] = args;
    if (command === 'validate') {
      if (args.length !== 2) return usage(io);
      const project = await validateKit(args[1]);
      io.stdout.write(lines([
        ['KIT_ID', project.manifest.id],
        ['KIT_VERSION', project.manifest.version],
        ['FILES', project.payload.length],
      ]));
      return 0;
    }
    if (command === 'pack') {
      if (args.length !== 4 || args[2] !== '--output' || args[3].length === 0) return usage(io);
      const packed = await packKit({ directory: args[1], output: args[3] });
      io.stdout.write(lines([
        ['KIT_ID', packed.id],
        ['KIT_VERSION', packed.version],
        ['OUTPUT', packed.output],
        ['SHA256', packed.sha256],
        ['SIZE', packed.size],
        ['FILES', packed.files],
      ]));
      return 0;
    }
    if (command === 'inspect') {
      if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--json')) {
        return usage(io);
      }
      const inspected = await inspectKit({ archive: args[1] });
      if (args[2] === '--json') {
        io.stdout.write(canonicalJson(inspected));
      } else {
        io.stdout.write(lines([
          ['KIT_ID', inspected.manifest.id],
          ['KIT_VERSION', inspected.manifest.version],
          ['SHA256', inspected.sha256],
          ['SIZE', inspected.compressedSize],
          ['FILES', inspected.files],
        ]));
      }
      return 0;
    }
    return usage(io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`ERROR=${message.replace(/[\r\n]+/gu, ' ')}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
