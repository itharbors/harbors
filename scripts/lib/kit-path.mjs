import path from 'node:path';

export function normalizeKitArgument(value, cwd = process.cwd()) {
  if (!value || path.isAbsolute(value) || value.startsWith('@')) return value;
  const looksLikePath = value.startsWith('.') || value.includes('/') || value.includes('\\');
  return looksLikePath ? path.resolve(cwd, value) : value;
}
