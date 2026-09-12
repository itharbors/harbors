import { readFile } from 'node:fs/promises';

export type Q30Category = 'single-turn' | 'multi-turn-correction' | 'ten-turn-delayed-recall';

export interface Q30Case {
  id: string;
  category: Q30Category;
  turns: string[];
  expected: { state: Record<string, unknown>; anchors: string[]; forbiddenState: Record<string, unknown[]> };
}

export interface ProviderAnswer {
  state: Record<string, unknown>;
  recalledAnchors: string[];
  answer: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s，。；：、,.!?！？:;]+/gu, '');
}

function unwrapSingleton(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? unwrapSingleton(value[0]) : value;
}

function stateValueMatches(actualValue: unknown, expectedValue: unknown): boolean {
  const actual = unwrapSingleton(actualValue);
  const expected = unwrapSingleton(expectedValue);
  if (typeof actual === 'string' && typeof expected === 'string') {
    const normalizedActual = normalizedText(actual);
    const normalizedExpected = normalizedText(expected);
    return normalizedActual === normalizedExpected || normalizedActual.includes(normalizedExpected);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => stateValueMatches(item, expected[index]));
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && !Array.isArray(actual) && !Array.isArray(expected)) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const keys = Object.keys(expectedRecord).sort();
    return canonical(Object.keys(actualRecord).sort()) === canonical(keys) && keys.every((key) => stateValueMatches(actualRecord[key], expectedRecord[key]));
  }
  return Object.is(actual, expected);
}

function stateMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const keys = Object.keys(expected).sort();
  return canonical(Object.keys(actual).sort()) === canonical(keys) && keys.every((key) => stateValueMatches(actual[key], expected[key]));
}

function includesForbidden(actual: unknown, forbidden: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => includesForbidden(item, forbidden));
  return stateValueMatches(actual, forbidden);
}

export async function loadQ30Fixture(url = new URL('./q30.fixture.json', import.meta.url)): Promise<Q30Case[]> {
  const parsed = JSON.parse(await readFile(url, 'utf8')) as { version?: unknown; cases?: unknown };
  if (parsed.version !== 2 || !Array.isArray(parsed.cases)) throw new Error('Q30_FIXTURE_INVALID');
  return parsed.cases as Q30Case[];
}

export function scoreAnswer(testCase: Q30Case, answer: ProviderAnswer): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!stateMatches(answer.state, testCase.expected.state)) failures.push('state_mismatch');
  const body = JSON.stringify([answer.state, answer.recalledAnchors, answer.answer]);
  const normalizedBody = normalizedText(body);
  for (const anchor of testCase.expected.anchors) if (!normalizedBody.includes(normalizedText(anchor))) failures.push(`missing_anchor:${anchor}`);
  for (const [key, values] of Object.entries(testCase.expected.forbiddenState)) {
    for (const value of values) if (includesForbidden(answer.state[key], value)) failures.push(`forbidden_state:${key}:${JSON.stringify(value)}`);
  }
  return { passed: failures.length === 0, failures };
}
