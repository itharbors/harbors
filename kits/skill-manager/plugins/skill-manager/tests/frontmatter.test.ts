import { describe, expect, it } from 'vitest';

import { SkillManagerError } from '../main/src/types.ts';
import { parseSkillFrontmatter } from '../main/src/frontmatter.ts';

describe('parseSkillFrontmatter', () => {
  it('projects quoted and block YAML values', () => {
    expect(parseSkillFrontmatter(`---
name: "design-taste"
description: >-
  Build distinctive interfaces
  without visual slop.
metadata:
  ignored: true
---
# Body
`)).toEqual({
      name: 'design-taste',
      description: 'Build distinctive interfaces without visual slop.',
    });
  });

  it.each([
    ['missing opening delimiter', 'name: valid\ndescription: valid\n'],
    ['missing closing delimiter', '---\nname: valid\ndescription: valid\n'],
    ['non-string name', '---\nname: 42\ndescription: valid\n---\n'],
    ['non-string description', '---\nname: valid\ndescription:\n  nested: value\n---\n'],
    ['empty name', '---\nname: ""\ndescription: valid\n---\n'],
    ['non-hyphen-case name', '---\nname: Not_Valid\ndescription: valid\n---\n'],
    ['unsafe hyphen placement', '---\nname: not--valid\ndescription: valid\n---\n'],
  ])('rejects %s', (_label, source) => {
    expect(() => parseSkillFrontmatter(source)).toThrowError(
      expect.objectContaining<Partial<SkillManagerError>>({ code: 'INVALID_SKILL' }),
    );
  });

  it('rejects duplicate YAML keys instead of silently selecting one', () => {
    expect(() => parseSkillFrontmatter(`---
name: first
name: second
description: duplicate
---
`)).toThrowError(expect.objectContaining({ code: 'INVALID_SKILL' }));
  });
});
