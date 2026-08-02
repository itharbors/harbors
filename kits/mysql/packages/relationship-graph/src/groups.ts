import { compareTableNames, normalizedTableName, tokenizeTableName } from './names.js';
import type { RelationshipGraph } from './types.js';

export type RelationshipGroupingOptions = {
  onCandidatePair?: (left: string, right: string) => void;
};

type NameEntry = {
  name: string;
  normalized: string;
  tokens: string[];
};

type ScoredPair = {
  left: string;
  right: string;
  score: number;
  key: string;
};

const CANDIDATE_WINDOW = 12;
const MAX_NAME_NEIGHBORS = 6;
const MAX_SOFT_GROUP_SIZE = 64;
const MIN_SIMILARITY_SCORE = 8;
const TECHNICAL_TOKENS = new Set([
  'data', 'detail', 'history', 'id', 'link', 'log', 'map', 'rel',
]);

export function groupRelationshipGraph(
  graph: RelationshipGraph,
  options: RelationshipGroupingOptions = {},
): Map<string, string> {
  const entries = graph.tables
    .map((table) => ({
      name: table.name,
      normalized: normalizedTableName(table.name),
      tokens: tokenizeTableName(table.name),
    }))
    .sort((left, right) => compareTableNames(left.name, right.name));
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const buckets = buildCandidateBuckets(entries);
  const seen = new Set<string>();
  const pairs: ScoredPair[] = [];

  for (const bucket of buckets.values()) {
    bucket.sort(compareTableNames);
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      const limit = Math.min(bucket.length, leftIndex + CANDIDATE_WINDOW + 1);
      for (let rightIndex = leftIndex + 1; rightIndex < limit; rightIndex += 1) {
        const leftName = bucket[leftIndex];
        const rightName = bucket[rightIndex];
        const key = pairKey(leftName, rightName);
        if (seen.has(key)) continue;
        seen.add(key);
        options.onCandidatePair?.(leftName, rightName);
        const score = similarity(entryByName.get(leftName)!, entryByName.get(rightName)!);
        if (score >= MIN_SIMILARITY_SCORE) {
          pairs.push({ left: leftName, right: rightName, score, key });
        }
      }
    }
  }

  const neighborPairs = selectBoundedNeighbors(entries, pairs);
  const union = new StableUnion(entries.map((entry) => entry.name));
  for (const pair of neighborPairs.sort(comparePairs)) {
    union.join(pair.left, pair.right, MAX_SOFT_GROUP_SIZE);
  }

  const members = new Map<string, string[]>();
  for (const entry of entries) {
    const root = union.root(entry.name);
    const group = members.get(root) ?? [];
    group.push(entry.name);
    members.set(root, group);
  }
  const keyByRoot = new Map<string, string>();
  for (const [root, names] of members) {
    names.sort(compareTableNames);
    keyByRoot.set(root, normalizedTableName(names[0]));
  }
  return new Map(entries.map((entry) => [entry.name, keyByRoot.get(union.root(entry.name))!]));
}

function buildCandidateBuckets(entries: NameEntry[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  const append = (key: string, name: string): void => {
    const values = buckets.get(key) ?? [];
    values.push(name);
    buckets.set(key, values);
  };
  for (const entry of entries) {
    for (const token of new Set(entry.tokens)) append(`token:${token}`, entry.name);
    const prefixSource = entry.tokens[0] ?? entry.normalized;
    if (prefixSource.length >= 4) append(`prefix:${prefixSource.slice(0, 4)}`, entry.name);
  }
  return buckets;
}

function similarity(left: NameEntry, right: NameEntry): number {
  let score = 0;
  if (left.tokens[0] !== undefined && left.tokens[0] === right.tokens[0]) score += 10;
  const rightTokens = new Set(right.tokens);
  for (const token of new Set(left.tokens)) {
    if (!rightTokens.has(token)) continue;
    score += TECHNICAL_TOKENS.has(token) ? 1 : 4;
  }
  const prefixLength = commonPrefixLength(left.normalized, right.normalized);
  if (prefixLength >= 4) score += Math.min(4, prefixLength - 3);
  return score;
}

function selectBoundedNeighbors(entries: NameEntry[], pairs: ScoredPair[]): ScoredPair[] {
  const byName = new Map(entries.map((entry) => [entry.name, [] as ScoredPair[]]));
  for (const pair of pairs) {
    byName.get(pair.left)!.push(pair);
    byName.get(pair.right)!.push(pair);
  }
  const selected = new Set<string>();
  for (const neighbors of byName.values()) {
    neighbors.sort(comparePairs);
    for (const pair of neighbors.slice(0, MAX_NAME_NEIGHBORS)) selected.add(pair.key);
  }
  return pairs.filter((pair) => selected.has(pair.key));
}

function comparePairs(left: ScoredPair, right: ScoredPair): number {
  return right.score - left.score || left.key.localeCompare(right.key, 'en');
}

function pairKey(left: string, right: string): string {
  return compareTableNames(left, right) <= 0 ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

class StableUnion {
  private readonly parent = new Map<string, string>();
  private readonly size = new Map<string, number>();

  constructor(names: string[]) {
    for (const name of names) {
      this.parent.set(name, name);
      this.size.set(name, 1);
    }
  }

  root(name: string): string {
    let current = name;
    while (this.parent.get(current) !== current) current = this.parent.get(current)!;
    let path = name;
    while (path !== current) {
      const next = this.parent.get(path)!;
      this.parent.set(path, current);
      path = next;
    }
    return current;
  }

  join(left: string, right: string, maximumSize: number): void {
    let leftRoot = this.root(left);
    let rightRoot = this.root(right);
    if (leftRoot === rightRoot) return;
    const combined = this.size.get(leftRoot)! + this.size.get(rightRoot)!;
    if (combined > maximumSize) return;
    if (compareTableNames(leftRoot, rightRoot) > 0) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parent.set(rightRoot, leftRoot);
    this.size.set(leftRoot, combined);
  }
}
