import { describe, expect, it } from 'vitest';

import { inferSkillEvidence } from '../main/src/skill-inference';
import type { RawEvent } from '../main/src/parse-rollout';

function event(id: string, rawOffset: number, text: string): RawEvent {
  return { id, rawOffset, timestamp: `2026-07-31T00:00:${rawOffset}.000Z`, type: 'event_msg', payload: { type: 'agent_message', message: text }, raw: {} };
}

describe('inferSkillEvidence', () => {
  it('ignores ordinary prose containing using', () => {
    expect(inferSkillEvidence([
      event('markdown', 1, 'Format the report using Markdown.'),
      event('react', 2, 'Build the interface using React.'),
    ])).toEqual([]);
  });

  it('accepts explicit announcements and never claims certainty', () => {
    const skills = inferSkillEvidence([
      event('suffix', 1, "I'm using the writing-plans skill to define the implementation."),
      event('prefix', 2, 'Using skill: frontend-design'),
    ]);
    expect(skills.map(skill => skill.label)).toEqual(['writing-plans', 'frontend-design']);
    expect(skills.every(skill => skill.confidence < 1)).toBe(true);
  });
});
