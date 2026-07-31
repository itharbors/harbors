import type { RawEvent } from './parse-rollout.js';

export interface SkillEvidence {
  label: string;
  timestamp: string;
  confidence: number;
  rule: 'skill_md_read' | 'skill_announcement' | 'skill_md_read_and_announcement';
  sourceEventIds: string[];
  rawOffsets: number[];
}

interface Match { label: string; event: RawEvent; source: 'path' | 'announcement' }

function maybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function strings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, output);
  return output;
}

function pathMatches(event: RawEvent): Match[] {
  const text = strings(maybeJson(event.payload.input ?? event.payload.arguments)).join('\n');
  return [...text.matchAll(/(?:^|[\s"'`])([^\s"'`]*\/([^/\s"'`]+)\/SKILL\.md)(?=$|[\s"'`])/gu)]
    .filter(match => Boolean(match[2]))
    .map(match => ({ label: match[2]!, event, source: 'path' as const }));
}

function announcementMatches(event: RawEvent): Match[] {
  const patterns = [
    /^(?:I(?:'m| am)\s+)?Using\s+skill\s*[:：]\s*([A-Za-z0-9:_-]+)\b/iu,
    /^(?:I(?:'m| am)\s+)?Using\s+(?:the\s+)?([A-Za-z0-9:_-]+)\s+skill\b/iu,
    /^(?:I(?:'m| am)\s+)?Using\s+(?:<([A-Za-z0-9:_-]+)>|`([A-Za-z0-9:_-]+)`)(?:\s+skill)?/iu,
  ];
  const matches: Match[] = [];
  for (const value of strings(event.payload)) for (const line of value.split(/\r?\n/u).map(item => item.trim())) {
    const match = patterns.map(pattern => pattern.exec(line)).find(Boolean);
    const label = match?.[1] ?? match?.[2];
    if (label) matches.push({ label, event, source: 'announcement' });
  }
  return matches;
}

export function inferSkillEvidence(events: RawEvent[]): SkillEvidence[] {
  const grouped = new Map<string, Match[]>();
  for (const event of events) for (const match of [...pathMatches(event), ...announcementMatches(event)]) {
    const key = match.label.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), match]);
  }
  return [...grouped.values()].map(matches => {
    const paths = matches.filter(match => match.source === 'path');
    const announcements = matches.filter(match => match.source === 'announcement');
    const eventsById = [...new Map(matches.map(match => [match.event.id, match.event])).values()]
      .sort((left, right) => left.rawOffset - right.rawOffset);
    const corroborated = paths.length > 0 && announcements.length > 0;
    return {
      label: matches[0].label,
      timestamp: eventsById[0].timestamp,
      confidence: corroborated ? 0.95 : paths.length > 0 ? 0.9 : 0.75,
      rule: corroborated ? 'skill_md_read_and_announcement'
        : paths.length > 0 ? 'skill_md_read' : 'skill_announcement',
      sourceEventIds: eventsById.map(event => event.id),
      rawOffsets: eventsById.map(event => event.rawOffset),
    };
  });
}
