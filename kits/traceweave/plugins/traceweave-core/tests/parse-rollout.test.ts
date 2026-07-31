import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRollout } from '../main/src/parse-rollout';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('parseRollout', () => {
  it('keeps valid records around malformed and future records', async () => {
    const parsed = await parseRollout(createReadStream(fixture('malformed.jsonl')));
    expect(parsed.events).toHaveLength(2);
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: 'malformed_json', line: 2 }));
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: 'unknown_event', eventType: 'future_record' }));
  });

  it('assigns stable opaque event ids and source offsets', async () => {
    const first = await parseRollout(createReadStream(fixture('two-turn.jsonl')));
    const second = await parseRollout(createReadStream(fixture('two-turn.jsonl')));
    expect(first.sessionId).toBe('session-test');
    expect(first.events.map(event => event.id)).toEqual(second.events.map(event => event.id));
    expect(first.events.at(-1)?.rawOffset).toBe(21);
  });
});
