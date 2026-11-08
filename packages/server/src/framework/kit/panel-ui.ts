import fs from 'node:fs';
import path from 'node:path';

/** Resolve the Kit's single public Panel UI bundle, never an arbitrary request path. */
export function resolveKitPanelUi(root: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9@._/-]+\.(?:m?js)$/u.test(value)
    || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Kit panelUi must be a relative .js or .mjs file path');
  }
  const resolved = path.resolve(root, value);
  let actualRoot: string;
  let actual: string;
  try {
    actualRoot = fs.realpathSync(root);
    actual = fs.realpathSync(resolved);
  } catch {
    throw new Error('Kit panelUi file does not exist');
  }
  if (!actual.startsWith(actualRoot + path.sep) || !fs.statSync(actual).isFile()) {
    throw new Error('Kit panelUi must be a regular file inside its Kit');
  }
  return value;
}
