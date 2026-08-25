import path from 'node:path';

export interface StartArguments {
  dataRoot?: string;
  help: boolean;
}

export function parseStartArguments(args: readonly string[]): StartArguments {
  let dataRoot: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (index === 0 && argument === '--') continue;
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }

    let value: string | undefined;
    if (argument === '--data-root') {
      value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--data-root requires an absolute path');
      index += 1;
    } else if (argument.startsWith('--data-root=')) {
      value = argument.slice('--data-root='.length);
      if (!value) throw new Error('--data-root requires an absolute path');
    } else {
      throw new Error(`Unknown start argument: ${argument}`);
    }

    if (dataRoot !== undefined) throw new Error('--data-root may only be specified once');
    if (!path.isAbsolute(value)) throw new Error('--data-root must be an absolute path');
    dataRoot = path.resolve(value);
  }

  return { dataRoot, help };
}

export function startHelp(): string {
  return [
    'Usage:',
    '  pnpm start',
    '  pnpm start -- --data-root <absolute-path>',
    '',
    'By default Harbors reads ~/.harbors. Use --data-root to switch the',
    'database, configuration, and Plugin data/cache/temp as one unit.',
  ].join('\n');
}

export function applyStartArgumentsToEnv<T extends Record<string, string | undefined> & { HARBORS_DATA_ROOT?: string }>(
  env: T,
  arguments_: StartArguments,
): T {
  if (arguments_.dataRoot) env.HARBORS_DATA_ROOT = arguments_.dataRoot;
  return env;
}
