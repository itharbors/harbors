import { parseDocument } from 'yaml';

import { SkillManagerError, type SkillManifest } from './types.ts';

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function parseSkillFrontmatter(source: string): SkillManifest {
  if (typeof source !== 'string') {
    throw invalid('SKILL.md must be text');
  }
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') {
    throw invalid('SKILL.md must start with a YAML frontmatter delimiter');
  }
  const closingDelimiter = lines.indexOf('---', 1);
  if (closingDelimiter < 0) {
    throw invalid('SKILL.md frontmatter is missing its closing delimiter');
  }

  const document = parseDocument(lines.slice(1, closingDelimiter).join('\n'), {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw invalid(`Invalid YAML frontmatter: ${document.errors[0].message}`);
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (caught) {
    throw invalid('Invalid YAML frontmatter', caught);
  }
  if (!isRecord(value)) {
    throw invalid('SKILL.md frontmatter must be a mapping');
  }

  const { name, description } = value;
  if (typeof name !== 'string') {
    throw invalid('Skill name must be a string');
  }
  if (typeof description !== 'string') {
    throw invalid('Skill description must be a string');
  }

  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  if (
    normalizedName.length === 0
    || normalizedName.length > MAX_SKILL_NAME_LENGTH
    || !SKILL_NAME.test(normalizedName)
  ) {
    throw invalid('Skill name must be 1-64 lowercase letters, digits, or single hyphens');
  }
  if (normalizedDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw invalid(`Skill description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (normalizedDescription.includes('<') || normalizedDescription.includes('>')) {
    throw invalid('Skill description must not contain angle brackets');
  }

  return { name: normalizedName, description: normalizedDescription };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string, cause?: unknown): SkillManagerError {
  return new SkillManagerError('INVALID_SKILL', message, cause === undefined ? undefined : { cause });
}
