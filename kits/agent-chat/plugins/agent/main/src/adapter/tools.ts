import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_OUTPUT = 12_000;

export interface HubBertTool { name: string; description: string; input_schema: Record<string, unknown>; }
export const hubbertTools: HubBertTool[] = [
  { name: 'list_files', description: '列出工作区内目录中的文件。', input_schema: { type: 'object', properties: { path: { type: 'string', description: '相对工作区路径，可省略。' } } } },
  { name: 'read_file', description: '读取工作区内的 UTF-8 文本文件。', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_text', description: '在工作区内搜索文本。', input_schema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } },
  { name: 'list_skills', description: '列出可按需加载的本地 Skill。先调用它确认名称，再调用 load_skill。', input_schema: { type: 'object', properties: {} } },
  { name: 'load_skill', description: '读取一个 Skill 的完整 SKILL.md 指引。', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

export async function runHubBertTool(name: string, input: Record<string, unknown>, workspace: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted');
  const root = resolve(workspace);
  if (name === 'list_files') return cap((await readdir(within(root, string(input.path)), { withFileTypes: true })).map((entry) => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).join('\n'));
  if (name === 'read_file') return cap(await readFile(within(root, required(input.path, 'path')), 'utf8'));
  if (name === 'search_text') {
    const { stdout } = await exec('rg', ['-n', '--max-count', '100', required(input.query, 'query'), string(input.path) || '.'], { cwd: root, timeout: 30_000, maxBuffer: MAX_OUTPUT, signal });
    return cap(stdout || '未找到匹配项');
  }
  if (name === 'list_skills') return cap((await skills(root)).map((skill) => skill.name).join('\n') || '未发现 Skill');
  if (name === 'load_skill') {
    const skill = (await skills(root)).find((entry) => entry.name === required(input.name, 'name'));
    if (!skill) throw new Error('Skill 不存在；请先调用 list_skills');
    return cap(await readFile(skill.path, 'utf8'));
  }
  throw new Error(`不支持的工具：${name}`);
}

async function skills(workspace: string): Promise<Array<{ name: string; path: string }>> {
  const roots = [resolve(workspace, '.agents/skills'), resolve(workspace, '.codex/skills'), resolve(homedir(), '.agents/skills'), resolve(homedir(), '.codex/skills')];
  const found: Array<{ name: string; path: string }> = [];
  for (const root of roots) {
    try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) found.push({ name: entry.name, path: resolve(root, entry.name, 'SKILL.md') }); } catch { /* optional root */ }
  }
  return [...new Map(found.map((skill) => [skill.name, skill])).values()];
}
function within(root: string, candidate: string): string { const resolved = resolve(root, candidate || '.'); const rel = relative(root, resolved); if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'))) return resolved; throw new Error('工具路径必须位于工作区内'); }
function required(value: unknown, name: string): string { const result = string(value); if (!result) throw new Error(`缺少参数：${name}`); return result; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function cap(value: string): string { return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…输出已截断` : value; }
