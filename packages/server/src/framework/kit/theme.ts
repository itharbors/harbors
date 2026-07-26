const THEME_TOKEN_PATTERN = /^--ce-[a-z0-9-]+$/;

export function normalizeKitTheme(
  input: unknown,
  kitName: string,
): Record<`--ce-${string}`, string> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Kit "${kitName}" theme must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [token, value] of Object.entries(input)) {
    if (!THEME_TOKEN_PATTERN.test(token)) {
      throw new Error(`Kit "${kitName}" has invalid theme token "${token}"`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Kit "${kitName}" theme token "${token}" must be a string`);
    }
    normalized[token] = value;
  }
  return normalized as Record<`--ce-${string}`, string>;
}
