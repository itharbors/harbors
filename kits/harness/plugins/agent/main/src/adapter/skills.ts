import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_NAME_CHARS = 64;
const MAX_FIELD_BYTES = 1_024;
export const SKILL_CATALOG_MAX_BYTES = 8_192;
export const SKILL_BODY_MAX_BYTES = 12_000;
const MIN_DESCRIPTION_BYTES = 32;
const ELLIPSIS = '...';
const HEADER = [
  'Available Skills:',
  'Before related action, fully load a Skill when the user names it or the task matches its description. Load only relevant Skills.',
  '',
].join('\n');
const FOOTER_TEMPLATE = 'catalog_status total=00000000 included=00000000 omitted=00000000 truncated=00000000 errors=00000000 shadowed=00000000\n';

export interface SkillEntry {
  name: string;
  description: string;
  displayPath: string;
  path: string;
  root: string;
  canonicalRoot: string;
  rootIdentity: string;
  scopeRank: 0 | 1;
  repoDepth: number;
}

export interface SkillDiagnostics {
  total: number;
  included: number;
  omitted: number;
  truncated: number;
  errors: number;
  shadowed: number;
}

export interface SkillCatalog {
  entries: SkillEntry[];
  visibleEntries: SkillEntry[];
  text: string;
  diagnostics: SkillDiagnostics;
}

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

async function projectRoot(workspace: string): Promise<string> {
  let current = resolve(workspace);
  for (;;) {
    try { await stat(join(current, '.git')); return current; } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) return resolve(workspace);
    current = parent;
  }
}

function chain(root: string, workspace: string): string[] {
  const result: string[] = [];
  let current = resolve(workspace);
  while (current !== root) { result.push(current); current = dirname(current); }
  result.push(root);
  return result.reverse();
}

function parseMetadata(source: string): { name: string; description: string } | undefined {
  const normalized = source.replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) return undefined;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return undefined;
  let data: unknown;
  try { data = parseYaml(normalized.slice(4, end)); } catch { return undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const description = normalizeDescription(record.description);
  if (!name || name.length > MAX_NAME_CHARS || !NAME.test(name) || !description) return undefined;
  if (bytes(description) > MAX_FIELD_BYTES) return undefined;
  return { name, description };
}

async function candidates(workspace: string, userSkillsRoot: string): Promise<{ entries: SkillEntry[]; errors: number }> {
  const root = await projectRoot(workspace);
  const roots: Array<{ path: string; scopeRank: 0 | 1; repoDepth: number; repoRoot: string }> = chain(root, workspace).map((dir, repoDepth) => ({
    path: resolve(dir, '.agents/skills'), scopeRank: 0 as const, repoDepth, repoRoot: root,
  }));
  roots.push({ path: resolve(userSkillsRoot), scopeRank: 1 as const, repoDepth: -1, repoRoot: root });
  const found: SkillEntry[] = [];
  let errors = 0;
  for (const skillRoot of roots) {
    let items;
    try { items = await readdir(skillRoot.path, { withFileTypes: true }); } catch { continue; }
    let canonicalRoot: string;
    let rootIdentity: string;
    try {
      canonicalRoot = await realpath(skillRoot.path);
      const rootInfo = await stat(canonicalRoot);
      if (!rootInfo.isDirectory()) { errors += 1; continue; }
      rootIdentity = `${rootInfo.dev}:${rootInfo.ino}`;
    } catch { errors += 1; continue; }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const path = resolve(skillRoot.path, item.name, 'SKILL.md');
      try {
        const info = await lstat(path);
        if (!info.isFile()) { errors += 1; continue; }
        await access(path, constants.R_OK);
        const metadata = parseMetadata(await readFile(path, 'utf8'));
        if (!metadata) { errors += 1; continue; }
        const displayPath = skillRoot.scopeRank === 0
          ? relative(skillRoot.repoRoot, path).split(sep).join('/')
          : `~/.agents/skills/${item.name}/SKILL.md`;
        if (bytes(displayPath) > MAX_FIELD_BYTES || /[\u0000-\u001f\u007f]/u.test(displayPath)) { errors += 1; continue; }
        const canonicalFile = await realpath(path);
        if (!within(canonicalRoot, canonicalFile)) { errors += 1; continue; }
        found.push({ ...metadata, displayPath, path, root: skillRoot.path, canonicalRoot, rootIdentity, scopeRank: skillRoot.scopeRank, repoDepth: skillRoot.repoDepth });
      } catch { errors += 1; }
    }
  }
  return { entries: found, errors };
}

function winnerSort(left: SkillEntry, right: SkillEntry): number {
  return left.scopeRank - right.scopeRank || right.repoDepth - left.repoDepth || compareUtf8(left.displayPath, right.displayPath);
}

function catalogSort(left: SkillEntry, right: SkillEntry): number {
  return left.scopeRank - right.scopeRank || compareUtf8(left.name, right.name) || compareUtf8(left.displayPath, right.displayPath);
}

function prefixByBytes(value: string, maxBytes: number): string {
  let result = '';
  for (const scalar of value) {
    if (bytes(result) + bytes(scalar) > maxBytes) break;
    result += scalar;
  }
  return result;
}

function descriptionAtMinimum(value: string): string {
  return bytes(value) <= MIN_DESCRIPTION_BYTES ? value : `${prefixByBytes(value, MIN_DESCRIPTION_BYTES - bytes(ELLIPSIS))}${ELLIPSIS}`;
}

function line(entry: SkillEntry, description: string): string {
  return `- ${entry.name}: ${description} (file: ${entry.displayPath})\n`;
}

function footer(values: SkillDiagnostics): string {
  for (const value of Object.values(values)) if (value > 99_999_999) throw new Error('[agent] skill catalog diagnostic count overflow');
  return `catalog_status total=${String(values.total).padStart(8, '0')} included=${String(values.included).padStart(8, '0')} omitted=${String(values.omitted).padStart(8, '0')} truncated=${String(values.truncated).padStart(8, '0')} errors=${String(values.errors).padStart(8, '0')} shadowed=${String(values.shadowed).padStart(8, '0')}\n`;
}

export function renderSkillCatalog(entries: SkillEntry[], errors = 0, shadowed = 0): { visibleEntries: SkillEntry[]; text: string; diagnostics: SkillDiagnostics } {
  const ordered = [...entries].sort(catalogSort);
  const included = [...ordered];
  const minimum = new Map(included.map((entry) => [entry.name, descriptionAtMinimum(entry.description)]));
  const fixedOverhead = bytes(HEADER) + bytes(FOOTER_TEMPLATE);
  while (included.length > 0 && fixedOverhead + included.reduce((sum, entry) => sum + bytes(line(entry, minimum.get(entry.name)!)), 0) > SKILL_CATALOG_MAX_BYTES) included.pop();
  const descriptions = new Map(included.map((entry) => [entry.name, minimum.get(entry.name)!]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of included) {
      const current = descriptions.get(entry.name)!;
      const visiblePrefix = current.endsWith(ELLIPSIS) ? current.slice(0, -ELLIPSIS.length) : current;
      if (visiblePrefix === entry.description) continue;
      const nextScalar = Array.from(entry.description.slice(visiblePrefix.length))[0];
      if (!nextScalar) continue;
      const nextPrefix = visiblePrefix + nextScalar;
      const next = nextPrefix === entry.description ? nextPrefix : `${nextPrefix}${ELLIPSIS}`;
      descriptions.set(entry.name, next);
      const body = included.map((candidate) => line(candidate, descriptions.get(candidate.name)!)).join('');
      if (fixedOverhead + bytes(body) <= SKILL_CATALOG_MAX_BYTES) changed = true;
      else descriptions.set(entry.name, current);
    }
  }
  const truncated = included.filter((entry) => descriptions.get(entry.name) !== entry.description).length;
  const diagnostics = { total: ordered.length, included: included.length, omitted: ordered.length - included.length, truncated, errors, shadowed };
  const text = `${HEADER}${included.map((entry) => line(entry, descriptions.get(entry.name)!)).join('')}${footer(diagnostics)}`;
  return { visibleEntries: included, text, diagnostics };
}

export async function discoverSkillCatalog(workspace: string, userSkillsRoot: string = resolve(homedir(), '.agents/skills')): Promise<SkillCatalog> {
  const discovered = await candidates(workspace, userSkillsRoot);
  const groups = new Map<string, SkillEntry[]>();
  for (const entry of discovered.entries) groups.set(entry.name, [...(groups.get(entry.name) || []), entry]);
  const entries = [...groups.values()].map((group) => group.sort(winnerSort)[0]).sort(catalogSort);
  const shadowed = discovered.entries.length - entries.length;
  return { entries, ...renderSkillCatalog(entries, discovered.errors, shadowed) };
}

export async function loadDiscoveredSkill(entry: SkillEntry): Promise<string> {
  const realRoot = await realpath(entry.root);
  const rootInfo = await stat(realRoot);
  if (realRoot !== entry.canonicalRoot || `${rootInfo.dev}:${rootInfo.ino}` !== entry.rootIdentity) {
    throw new Error(`Skill ${entry.name} 允许根身份已变化`);
  }
  const realFile = await realpath(entry.path);
  if (!within(entry.canonicalRoot, realFile)) throw new Error(`Skill ${entry.name} 路径已逃逸允许根`);
  const info = await lstat(realFile);
  if (!info.isFile()) throw new Error(`Skill ${entry.name} 不是普通文件`);
  const content = await readFile(realFile, 'utf8');
  if (bytes(content) > SKILL_BODY_MAX_BYTES) throw new Error(`Skill ${entry.name} 超过 ${SKILL_BODY_MAX_BYTES} UTF-8 字节限制`);
  const metadata = parseMetadata(content);
  if (!metadata || metadata.name !== entry.name) throw new Error(`Skill ${entry.name} 元数据已变化或损坏`);
  return content;
}
