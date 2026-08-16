import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync as fsWriteFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentPermissionOutcome, AgentPermissionRequest, AgentPermissionState, AgentSandboxMode } from './base.js';
import { readDshRelayConfig } from './dsh-config.js';
import { resolveDshCredential } from './credentials.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 12_000;
const READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const SEARCH_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_MS = 120_000;
const WEB_TIMEOUT_MS = 30_000;
const WEB_MAX_BODY_CHARS = 20_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface HubBertTool { name: string; description: string; input_schema: Record<string, unknown>; }

export const hubbertTools: HubBertTool[] = [
  { name: 'list_files', description: '列出工作区内目录中的文件。', input_schema: { type: 'object', properties: { path: { type: 'string', description: '相对工作区路径，可省略。' } } } },
  { name: 'read_file', description: '读取工作区内的 UTF-8 文本文件。', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_text', description: '在工作区内搜索文本。', input_schema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } },
  { name: 'list_skills', description: '列出可按需加载的本地 Skill。先调用它确认名称，再调用 load_skill。', input_schema: { type: 'object', properties: {} } },
  { name: 'load_skill', description: '读取一个 Skill 的完整 SKILL.md 指引。', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  {
    name: 'read',
    description: '读取工作区内的 UTF-8 文本文件，返回带行号的内容。使用 offset 和 limit 分段读取大文件。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对工作区的文件路径。' },
        offset: { type: 'number', description: '起始行号（1-based），默认 1。' },
        limit: { type: 'number', description: '最多返回行数，默认 2000。' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write',
    description: '创建或完全覆盖工作区内的 UTF-8 文本文件。覆盖前请先 read 确认内容。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对工作区的文件路径。' },
        content: { type: 'string', description: '要写入的完整 UTF-8 文本内容。' },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: '仅在当前沙盒拒绝后，用于请求一次更宽的权限；必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次文件操作为什么需要更宽的权限。' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit',
    description: '对工作区内已有的 UTF-8 文本文件做字面量替换。默认 old_string 必须唯一出现；若有多处可设 replace_all 为 true。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对工作区的文件路径。' },
        old_string: { type: 'string', description: '要被替换的字面量文本。' },
        new_string: { type: 'string', description: '替换后的文本，可为空字符串以删除匹配。' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false。' },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: '仅在当前沙盒拒绝后，用于请求一次更宽的权限；必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次文件操作为什么需要更宽的权限。' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: '按 glob 模式查找工作区内的文件路径（不含目录），包含隐藏和被忽略文件，按修改时间排序。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts、src/**/*.test.js。不含 / 时匹配任意深度的文件名。' },
        path: { type: 'string', description: '搜索起始目录，默认工作区。' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: '用 ripgrep 正则搜索工作区内文件内容，返回带行号的匹配行，按文件分组。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ripgrep 正则表达式。' },
        path: { type: 'string', description: '搜索的文件或目录，默认工作区。' },
        include: { type: 'string', description: '文件 glob 过滤，如 *.ts、*.{js,jsx}。' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: '在工作区执行 bash 命令并返回 stdout/stderr。每次调用都是独立 shell，不保留 cwd/变量；用 workdir 指定目录。非零退出码会在结果中标注。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令。' },
        description: { type: 'string', description: '命令用途的简短描述。' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 120000。' },
        workdir: { type: 'string', description: '工作目录，默认工作区；相对路径按工作区解析。' },
        sandbox_permissions: { type: 'string', enum: ['danger-full-access'], description: '当前实现无法为 bash 提供操作系统级 workspace-write 隔离；仅可请求一次 danger-full-access，并且必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次命令为什么需要更宽的权限。' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: '搜索互联网获取当前信息，返回来源 URL 列表及摘要。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '获取指定 HTTP(S) URL 的内容并转为文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取的 HTTP(S) URL。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_image',
    description: '读取工作区内的 PNG、JPEG、WebP 或 GIF 图片，并将图片本身传给当前模型。当前模型需要支持视觉输入。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对工作区的图片路径。' },
      },
      required: ['file_path'],
    },
  },
];

/** 串行执行 write/edit/bash 的互斥锁，避免并发写冲突。 */
let writeMutex: Promise<unknown> = Promise.resolve();

async function runExclusive<T>(fn: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const current = writeMutex;
  let release!: () => void;
  writeMutex = new Promise<void>((resolve) => { release = resolve; });
  try {
    if (signal) await Promise.race([current, abortPromise(signal)]);
    else await current;
    throwIfToolAborted(signal);
    return await fn();
  } finally {
    release();
  }
}

export interface HubBertToolImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  base64: string;
}

export interface HubBertToolResult {
  text: string;
  image?: HubBertToolImage;
}

export interface HubBertToolPermissionContext extends AgentPermissionState {
  conversationId: string;
  turn: number;
  step: number;
  requestPermission?: (request: Omit<AgentPermissionRequest, 'requestId' | 'conversationId' | 'turn' | 'step' | 'signal'> & { signal?: AbortSignal }) => Promise<AgentPermissionOutcome>;
}

class SandboxPermissionRequiredError extends Error {
  constructor(readonly requestedMode: AgentSandboxMode, message: string) {
    super(message);
  }
}

export async function runHubBertTool(name: string, input: Record<string, unknown>, workspace: string, signal?: AbortSignal, permission?: HubBertToolPermissionContext): Promise<string> {
  return (await runHubBertToolContent(name, input, workspace, signal, permission)).text;
}

export async function runHubBertToolContent(name: string, input: Record<string, unknown>, workspace: string, signal?: AbortSignal, permission?: HubBertToolPermissionContext): Promise<HubBertToolResult> {
  throwIfToolAborted(signal);
  const root = resolve(workspace);
  try {
    return await runHubBertToolAttempt(name, input, workspace, root, signal, permission);
  } catch (error) {
    if (!(error instanceof SandboxPermissionRequiredError)) throw error;
    const mode = await requestSandboxMode(name, input, permission, error.requestedMode, signal, error.message);
    const retryInput = { ...input };
    delete retryInput.sandbox_permissions;
    delete retryInput.justification;
    return runHubBertToolAttempt(name, retryInput, workspace, root, signal, permission ? { ...permission, sandboxMode: mode } : permission);
  }
}

async function runHubBertToolAttempt(name: string, input: Record<string, unknown>, workspace: string, root: string, signal?: AbortSignal, permission?: HubBertToolPermissionContext): Promise<HubBertToolResult> {
  if (name === 'read_image') return runReadImage(root, input, signal, permission?.sandboxMode);
  return { text: await runHubBertToolText(name, input, workspace, signal, permission) };
}

async function runHubBertToolText(name: string, input: Record<string, unknown>, workspace: string, signal?: AbortSignal, permission?: HubBertToolPermissionContext): Promise<string> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted');
  const root = resolve(workspace);

  if (name === 'list_files') return cap((await readdir(resolveToolPath(root, string(input.path), permission?.sandboxMode), { withFileTypes: true })).map((entry) => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).join('\n'));
  if (name === 'read_file') return cap(await readFile(resolveToolPath(root, required(input.path, 'path'), permission?.sandboxMode), 'utf8'));
  if (name === 'search_text') {
    const searchPath = string(input.path) ? resolveToolPath(root, string(input.path), permission?.sandboxMode) : root;
    try {
      const { stdout } = await exec('rg', ['-n', '--max-count', '100', required(input.query, 'query'), searchPath], { cwd: root, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 8, signal });
      return cap(stdout || '未找到匹配项');
    } catch (error) {
      if ((error as { code?: number }).code === 1) return '未找到匹配项';
      if (isOutputLimitError(error)) return truncatedOutput((error as { stdout?: string }).stdout);
      throw error;
    }
  }
  if (name === 'list_skills') return cap((await skills(root)).map((skill) => skill.name).join('\n') || '未发现 Skill');
  if (name === 'load_skill') {
    const skill = (await skills(root)).find((entry) => entry.name === required(input.name, 'name'));
    if (!skill) throw new Error('Skill 不存在；请先调用 list_skills');
    return cap(await readFile(skill.path, 'utf8'));
  }

  if (name === 'read') return runRead(root, input, permission?.sandboxMode);
  if (name === 'write') return runExclusive(() => runWrite(root, input, permission, signal), signal);
  if (name === 'edit') return runExclusive(() => runEdit(root, input, permission, signal), signal);
  if (name === 'glob') return runGlob(root, input, signal, permission?.sandboxMode);
  if (name === 'grep') return runGrep(root, input, signal, permission?.sandboxMode);
  if (name === 'bash') return runExclusive(() => runBash(root, input, signal, permission), signal);
  if (name === 'web_search') return runWebSearch(input, signal);
  if (name === 'web_fetch') return runWebFetch(input, signal);

  throw new Error(`不支持的工具：${name}`);
}

function runRead(root: string, input: Record<string, unknown>, mode?: AgentSandboxMode): string {
  const filePath = required(input.file_path, 'file_path');
  const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit = Math.min(READ_LIMIT, Math.max(1, Math.floor(Number(input.limit) || READ_LIMIT)));
  const content = readFileSync(resolveToolPath(root, filePath, mode), 'utf8');
  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = offset - 1;
  const end = Math.min(start + limit, totalLines);
  const window = lines.slice(start, end).map((line, index) => {
    const num = start + index + 1;
    const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
    return `${num}\t${text}`;
  });
  const header = `<path>${filePath}</path>\n<type>file</type>\n<content>`;
  const body = window.join('\n');
  const footer = end < totalLines ? `\n… (${totalLines - end} more lines)` : '';
  return cap(`${header}\n${body}${footer}\n</content>`);
}

async function runReadImage(root: string, input: Record<string, unknown>, signal?: AbortSignal, mode?: AgentSandboxMode): Promise<HubBertToolResult> {
  const filePath = required(input.file_path, 'file_path');
  const extension = extname(filePath).toLowerCase();
  const mediaTypes: Record<string, HubBertToolImage['mediaType']> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  const mediaType = mediaTypes[extension];
  if (!mediaType) throw new Error(`read_image 只支持 PNG、JPEG、WebP 和 GIF：${filePath}`);
  const target = resolveToolPath(root, filePath, mode);
  const data = await readFile(target);
  throwIfToolAborted(signal);
  if (data.byteLength > IMAGE_MAX_BYTES) throw new Error(`图片超过 ${IMAGE_MAX_BYTES / 1024 / 1024} MB 限制：${filePath}`);
  if (!matchesImageSignature(data, mediaType)) throw new Error(`图片扩展名与实际文件格式不匹配：${filePath}`);
  return {
    text: `<path>${filePath}</path>\n<type>image</type>\n<content>\n${mediaType} image, ${data.byteLength} bytes\n</content>`,
    image: { mediaType, base64: data.toString('base64') },
  };
}

function matchesImageSignature(data: Buffer, mediaType: HubBertToolImage['mediaType']): boolean {
  if (mediaType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mediaType === 'image/gif') return data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a');
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function runWrite(root: string, input: Record<string, unknown>, permission?: HubBertToolPermissionContext, signal?: AbortSignal): Promise<string> {
  const mode = await resolveToolMode('write', input, permission, signal);
  const filePath = required(input.file_path, 'file_path');
  const content = typeof input.content === 'string' ? input.content : '';
  const target = resolveToolPath(root, filePath, mode);
  mkdirSync(dirname(target), { recursive: true });
  fsWriteFileSync(target, content, 'utf8');
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\nFile written successfully\n</content>`;
}

async function runEdit(root: string, input: Record<string, unknown>, permission?: HubBertToolPermissionContext, signal?: AbortSignal): Promise<string> {
  const mode = await resolveToolMode('edit', input, permission, signal);
  const filePath = required(input.file_path, 'file_path');
  const oldString = required(input.old_string, 'old_string');
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  const replaceAll = Boolean(input.replace_all);
  if (oldString === newString) throw new Error('old_string 和 new_string 必须不同');
  const target = resolveToolPath(root, filePath, mode);
  const original = readFileSync(target, 'utf8');
  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) throw new Error('未找到 old_string');
  if (!replaceAll && occurrences > 1) throw new Error(`old_string 出现 ${occurrences} 次，请提供更具体的匹配或设置 replace_all 为 true`);
  const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  fsWriteFileSync(target, updated, 'utf8');
  return `The file ${filePath} has been updated${replaceAll ? '. All occurrences were successfully replaced.' : ' successfully.'}`;
}

async function runGlob(root: string, input: Record<string, unknown>, signal?: AbortSignal, mode?: AgentSandboxMode): Promise<string> {
  const pattern = required(input.pattern, 'pattern');
  const path = string(input.path) ? resolveToolPath(root, string(input.path), mode) : root;
  const args = ['--files', `--glob=${pattern}`, '--sort=modified', '--no-ignore', '--hidden'];
  for (const vcs of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
    args.push(`--glob=!**/${vcs}`, `--glob=!**/${vcs}/**`);
  }
  args.push('--', path);
  let stdout = '';
  let truncated = false;
  try { ({ stdout } = await exec('rg', args, { cwd: root, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 8, signal })); }
  catch (error) {
    if ((error as { code?: number }).code === 1) return 'No files found';
    if (!isOutputLimitError(error)) throw error;
    stdout = (error as { stdout?: string }).stdout || '';
    truncated = true;
  }
  const lines = stdout.split('\n').filter(Boolean);
  if (!lines.length) return 'No files found';
  return cap(`${lines.join('\n')}${truncated ? '\n[glob output truncated; narrow the pattern or path]' : ''}`);
}

async function runGrep(root: string, input: Record<string, unknown>, signal?: AbortSignal, mode?: AgentSandboxMode): Promise<string> {
  const pattern = required(input.pattern, 'pattern');
  const path = string(input.path) ? resolveToolPath(root, string(input.path), mode) : root;
  const include = string(input.include);
  const args = ['--json', `--regexp=${pattern}`];
  if (include) args.push(`--glob=${include}`);
  args.push('--', path);
  let stdout = '';
  let truncated = false;
  try { ({ stdout } = await exec('rg', args, { cwd: root, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 8, signal })); }
  catch (error) {
    if ((error as { code?: number }).code === 1) return 'No matches found';
    if (!isOutputLimitError(error)) throw error;
    stdout = (error as { stdout?: string }).stdout || '';
    truncated = true;
  }
  const matches = parseGrepJson(stdout);
  if (!matches.length) return 'No matches found';
  const byFile = new Map<string, typeof matches>();
  for (const match of matches) {
    const group = byFile.get(match.path) || [];
    group.push(match);
    byFile.set(match.path, group);
  }
  const sections: string[] = [];
  for (const [filePath, group] of byFile) {
    sections.push(`${filePath}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`);
  }
  return cap(`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}\n\n${sections.join('\n\n')}${truncated ? '\n[grep output truncated; narrow the pattern or path]' : ''}`);
}

async function runBash(root: string, input: Record<string, unknown>, signal?: AbortSignal, permission?: HubBertToolPermissionContext): Promise<string> {
  const mode = await resolveToolMode('bash', input, permission, signal);
  const command = required(input.command, 'command');
  const timeoutMs = Math.min(BASH_TIMEOUT_MS, Math.max(1, Math.floor(Number(input.timeoutMs) || BASH_TIMEOUT_MS)));
  const workdirArg = string(input.workdir);
  const cwd = workdirArg ? resolveToolPath(root, workdirArg, mode) : root;
  try {
    const { stdout, stderr } = await exec('bash', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 8, signal });
    const out = cap(stdout);
    const err = cap(stderr);
    return [out, err].filter(Boolean).join('\n') || '(no output)';
  } catch (error) {
    if (signal?.aborted) throw error;
    const err = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
    const out = cap(err.stdout || '');
    const errOut = cap(err.stderr || '');
    const body = [out, errOut].filter(Boolean).join('\n');
    const code = err.code ?? (err.signal ? `signal ${err.signal}` : 'unknown');
    return cap(`${body}\n[exit code: ${code}]`);
  }
}

async function skills(workspace: string): Promise<Array<{ name: string; path: string }>> {
  const roots = [resolve(workspace, '.agents/skills'), resolve(homedir(), '.agents/skills')];
  const found: Array<{ name: string; path: string }> = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) found.push({ name: entry.name, path: resolve(root, entry.name, 'SKILL.md') });
      }
    } catch { /* optional root */ }
  }
  return [...new Map(found.map((skill) => [skill.name, skill])).values()];
}

interface GrepMatch { path: string; lineNumber: number; line: string; }

function parseGrepJson(output: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      if (event.type !== 'match' || !event.data?.path?.text || !event.data.line_number) continue;
      matches.push({ path: event.data.path.text, lineNumber: event.data.line_number, line: (event.data.lines?.text || '').replace(/\n$/u, '') });
    } catch { /* ignore malformed ripgrep diagnostics */ }
  }
  return matches;
}

const WIDER_SANDBOX_MODES: Record<AgentSandboxMode, readonly AgentSandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
};

async function resolveToolMode(toolName: string, input: Record<string, unknown>, permission: HubBertToolPermissionContext | undefined, signal?: AbortSignal): Promise<AgentSandboxMode> {
  const currentMode = permission?.sandboxMode || 'workspace-write';
  const explicitRequestedMode = string(input.sandbox_permissions) as AgentSandboxMode | '';
  const justification = string(input.justification);
  if (explicitRequestedMode && !justification.trim()) throw new Error('sandbox_permissions 必须同时提供非空 justification');
  if (!explicitRequestedMode && justification) throw new Error('justification 只能和 sandbox_permissions 一起使用');
  const requestedMode = explicitRequestedMode || requiredToolMode(toolName, currentMode);
  if (!requestedMode) return currentMode;
  if (toolName === 'bash' && requestedMode !== 'danger-full-access') {
    throw new Error('当前实现无法为 bash 提供 workspace-write 级别的操作系统隔离；请请求 danger-full-access');
  }
  if (!Object.prototype.hasOwnProperty.call(WIDER_SANDBOX_MODES, requestedMode) || !(WIDER_SANDBOX_MODES[currentMode] || []).includes(requestedMode)) {
    throw new Error(`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${currentMode}" mode`);
  }
  return requestSandboxMode(toolName, input, permission, requestedMode, signal, justification || `工具 ${toolName} 在 ${currentMode} 模式下执行此操作需要 ${requestedMode} 权限`);
}

function requiredToolMode(toolName: string, currentMode: AgentSandboxMode): AgentSandboxMode | undefined {
  if (toolName === 'bash' && currentMode !== 'danger-full-access') return 'danger-full-access';
  if (currentMode === 'read-only' && (toolName === 'write' || toolName === 'edit')) return 'workspace-write';
  return undefined;
}

async function requestSandboxMode(toolName: string, input: Record<string, unknown>, permission: HubBertToolPermissionContext | undefined, requestedMode: AgentSandboxMode, signal: AbortSignal | undefined, justification: string): Promise<AgentSandboxMode> {
  const currentMode = permission?.sandboxMode || 'workspace-write';
  if (!permission?.requestPermission) throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`);
  const outcome = await permission.requestPermission({ toolName, currentMode, requestedMode, justification: justification || string(input.description), signal });
  switch (outcome) {
    case 'allowed-once': return requestedMode;
    case 'rejected': throw new Error(`用户拒绝将 ${toolName} 提升到 "${requestedMode}" 权限`);
    case 'cancelled': throw new Error(`提升到 "${requestedMode}" 的权限请求已取消`);
    case 'unavailable': throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`);
    default: throw new Error(`未知的权限审批结果：${String(outcome)}`);
  }
}

function resolveToolPath(root: string, candidate: string, mode?: AgentSandboxMode): string {
  if (mode === 'danger-full-access') return resolve(root, candidate || '.');
  const resolved = resolve(root, candidate || '.');
  if (isWithin(root, resolved)) return resolved;
  throw new SandboxPermissionRequiredError('danger-full-access', `路径超出当前工作区范围，需要 danger-full-access 权限：${candidate}`);
}

function isWithin(root: string, resolved: string): boolean { const rel = relative(root, resolved); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..')); }

function isOutputLimitError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer length exceeded/iu.test(String(value.message || ''));
}

function truncatedOutput(output: string | undefined): string {
  return `${cap(output || '')}\n[tool output truncated; narrow the path or query]`;
}

function required(value: unknown, name: string): string {
  const result = string(value);
  if (!result) throw new Error(`缺少参数：${name}`);
  return result;
}

function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

function throwIfToolAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted');
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted'));
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted')), { once: true }));
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + search.length;
  }
}

function cap(value: string): string { return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…输出已截断` : value; }

async function runWebSearch(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = required(input.query, 'query');
  const endpoint = process.env.HARBORS_WEB_SEARCH_URL;
  if (!endpoint) return runNativeWebSearch(query, signal);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
    signal: requestTimeoutSignal(signal, WEB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`web_search 请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as unknown;
  return cap(formatSearchPayload(payload));
}

async function runNativeWebSearch(query: string, signal?: AbortSignal): Promise<string> {
  const config = await readDshRelayConfig();
  const baseUrl = (process.env.HARBORS_WEB_SEARCH_BASE_URL || process.env.HARBORS_RELAY_BASE_URL || config.baseUrl || '').replace(/\/$/u, '');
  const apiKey = process.env.HARBORS_WEB_SEARCH_API_KEY || process.env.HARBORS_RELAY_API_KEY || (await resolveDshCredential(config.apiKeyEnv))?.value;
  if (!baseUrl || !apiKey) throw new Error('未配置 web_search：请设置 HARBORS_WEB_SEARCH_URL，或配置 DSH Relay 的 baseURL/apiKeyEnv');
  const model = process.env.HARBORS_WEB_SEARCH_MODEL || process.env.HARBORS_RELAY_MODEL || config.defaultModel || 'deepseek-v4-flash';
  const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
    signal: requestTimeoutSignal(signal, WEB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`web_search 请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as { content?: Array<Record<string, unknown>> };
  const sources = (payload.content || []).flatMap((block) => {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) return [];
    return (block.content as Array<Record<string, unknown>>).filter((item) => item.type === 'web_search_result').map((item) => ({ title: item.title, url: item.url, snippet: item.snippet || item.description }));
  });
  if (!sources.length) throw new Error('web_search 服务未返回结构化搜索结果');
  return cap(formatSearchPayload(sources));
}

async function runWebFetch(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const url = required(input.url, 'url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('web_fetch 只接受有效的 HTTP(S) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('web_fetch 只接受 HTTP(S) URL');
  const response = await fetch(parsed, { redirect: 'follow', signal: requestTimeoutSignal(signal, WEB_TIMEOUT_MS), headers: { accept: 'text/html, text/plain, application/json' } });
  if (!response.ok) throw new Error(`web_fetch 请求失败（HTTP ${response.status}）`);
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  const text = contentType.includes('html') ? htmlToText(body) : body;
  return cap(`<url>${parsed.toString()}</url>\n<content>\n${text.slice(0, WEB_MAX_BODY_CHARS)}\n</content>`);
}

function requestTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function formatSearchPayload(payload: unknown): string {
  if (Array.isArray(payload)) return payload.map((item) => formatSearchItem(item)).filter(Boolean).join('\n\n') || '未找到搜索结果';
  if (!payload || typeof payload !== 'object') return String(payload);
  const object = payload as Record<string, unknown>;
  const results = object.results || object.sources || object.items || object.data;
  if (Array.isArray(results)) return results.map((item) => formatSearchItem(item)).filter(Boolean).join('\n\n') || '未找到搜索结果';
  return JSON.stringify(payload, null, 2);
}

function formatSearchItem(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const value = item as Record<string, unknown>;
  const title = string(value.title) || string(value.name);
  const url = string(value.url) || string(value.link);
  const snippet = string(value.snippet) || string(value.description) || string(value.content);
  return [title, url, snippet].filter(Boolean).join('\n');
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n\s*\n+/gu, '\n\n')
    .trim();
}
