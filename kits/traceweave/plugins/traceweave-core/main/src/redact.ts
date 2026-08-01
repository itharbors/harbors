const secretKeyPattern = /^(authorization|api_?key|access_?token|refresh_?token|password|secret|cookie)$/iu;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'string' && /^\s*[\[{]/u.test(value)) {
    try { return JSON.stringify(redactSecrets(JSON.parse(value))); } catch { return value; }
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    secretKeyPattern.test(key.replace(/[-\s]/gu, '_')) ? '[REDACTED]' : redactSecrets(entry),
  ]));
}
