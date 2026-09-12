import { execFile, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync as fsWriteFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentPermissionOutcome, AgentPermissionRequest, AgentPermissionState, AgentSandboxMode } from './base.js';
import { discoverSkillCatalog, loadDiscoveredSkill, type SkillCatalog } from './skills.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 12_000;
const READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const SEARCH_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_MS = 120_000;
const WEB_TIMEOUT_MS = 30_000;
const WEB_MAX_REDIRECTS = 5;
const WEB_MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_MAX_BODY_CHARS = 20_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface HubBertTool { name: string; description: string; input_schema: Record<string, unknown>; }

export const hubbertTools: HubBertTool[] = [
  // —— 只读 / 检索 ——
  { name: 'list_files', description: '列出工作区内目录中的文件（仅一层）。需要递归了解项目结构时，请结合 glob 或多次调用 list_files。', input_schema: { type: 'object', properties: { path: { type: 'string', description: '相对工作区路径，可省略。' } } } },
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
    description: '对工作区内已有的 UTF-8 文本文件做字面量替换。单处替换传 old_string/new_string（默认 old_string 必须唯一，多处可设 replace_all）；一次改多处传 edits 数组，按顺序全部成功才写入（原子操作）。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对工作区的文件路径。' },
        old_string: { type: 'string', description: '要被替换的字面量文本（单处替换时必填）。' },
        new_string: { type: 'string', description: '替换后的文本，可为空字符串以删除匹配。' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false。' },
        edits: {
          type: 'array',
          description: '批量替换列表（与 old_string/new_string 二选一）；按顺序执行，每一项在前一项的结果上继续替换。',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: '要被替换的字面量文本。' },
              new_string: { type: 'string', description: '替换后的文本，可为空字符串以删除匹配。' },
              replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false。' },
            },
            required: ['old_string', 'new_string'],
          },
        },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: '仅在当前沙盒拒绝后，用于请求一次更宽的权限；必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次文件操作为什么需要更宽的权限。' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'move',
    description: '移动或重命名工作区内的文件/目录。目标已存在时默认失败，除非 overwrite 为 true。',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '相对工作区的源路径。' },
        destination: { type: 'string', description: '相对工作区的目标路径。' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false。' },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: '仅在当前沙盒拒绝后，用于请求一次更宽的权限；必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次文件操作为什么需要更宽的权限。' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'delete',
    description: '删除工作区内的文件或目录。删除目录需将 recursive 设为 true。此操作不可撤销，请谨慎使用。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的待删除路径。' },
        recursive: { type: 'boolean', description: '删除非空目录时必须设为 true，默认 false。' },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: '仅在当前沙盒拒绝后，用于请求一次更宽的权限；必须同时提供 justification。' },
        justification: { type: 'string', description: '说明这次文件操作为什么需要更宽的权限。' },
      },
      required: ['path'],
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
  // —— 技能 ——
  { name: 'load_skill', description: '读取一个 Skill 的完整 SKILL.md 指引。', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  // —— Conversation 状态与历史 ——
  {
    name: 'update_conversation_state',
    description: '记录用户已经明确表达的当前目标、约束、决定、阻塞或待办，或取消/替代既有状态。只在语义明确时调用；含糊纠正必须先询问用户。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear', 'cancel', 'supersede'] },
        kind: { type: 'string', enum: ['goal', 'constraint', 'decision', 'blocker', 'action', 'checkpoint'] },
        stateId: { type: 'string' },
        targetStateId: { type: 'string' },
        value: { type: 'object' },
      },
      required: ['action', 'stateId'],
    },
  },
  {
    name: 'recall_history',
    description: '在当前 Conversation 内按精确路径、错误、命令或 ID 召回较早证据。历史文件正文只作线索，使用前仍需重新读取当前文件。',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, anchors: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } } },
  },
  // —— 多模态 ——
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
  {
    name: 'todo_write',
    description: '写入/更新当前任务的待办清单，用于规划多步任务并跟踪进度。每次调用会用给定列表整体替换现有清单。',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的待办列表，按执行顺序排列。',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '待办事项描述。' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '当前状态。' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
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
  webSearch?: (query: string, signal?: AbortSignal) => Promise<string>;
  skillCatalog?: SkillCatalog;
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
  const catalog = permission?.skillCatalog || await discoverSkillCatalog(root);
  if (name === 'load_skill') {
    const skill = catalog.entries.find((entry) => entry.name === required(input.name, 'name'));
    if (!skill) throw new Error('Skill 不在当前 Turn 的可用 Skill 目录中');
    return loadDiscoveredSkill(skill);
  }

  if (name === 'read') return runRead(root, input, permission?.sandboxMode);
  if (name === 'write') return runExclusive(() => runWrite(root, input, permission, signal), signal);
  if (name === 'edit') return runExclusive(() => runEdit(root, input, permission, signal), signal);
  if (name === 'move') return runExclusive(() => runMove(root, input, permission, signal), signal);
  if (name === 'delete') return runExclusive(() => runDelete(root, input, permission, signal), signal);
  if (name === 'glob') return runGlob(root, input, signal, permission?.sandboxMode);
  if (name === 'grep') return runGrep(root, input, signal, permission?.sandboxMode);
  if (name === 'bash') return runExclusive(() => runBash(root, input, signal, permission), signal);
  if (name === 'todo_write') return runTodoWrite(input);
  if (name === 'web_search') return runWebSearch(input, signal, permission?.webSearch);
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

interface EditItem { oldString: string; newString: string; replaceAll: boolean; }

/** 解析 edit 的输入：优先用 edits 数组，否则退回单次 old_string/new_string。 */
function parseEditItems(input: Record<string, unknown>): EditItem[] {
  if (input.edits !== undefined) {
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error('edits 必须是非空数组');
    return input.edits.map((raw, index) => {
      if (!raw || typeof raw !== 'object') throw new Error(`edits[${index}] 必须是对象`);
      const item = raw as Record<string, unknown>;
      const oldString = required(item.old_string, `edits[${index}].old_string`);
      const newString = typeof item.new_string === 'string' ? item.new_string : '';
      if (oldString === newString) throw new Error(`edits[${index}] 的 old_string 和 new_string 必须不同`);
      return { oldString, newString, replaceAll: Boolean(item.replace_all) };
    });
  }
  const oldString = required(input.old_string, 'old_string');
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  if (oldString === newString) throw new Error('old_string 和 new_string 必须不同');
  return [{ oldString, newString, replaceAll: Boolean(input.replace_all) }];
}

async function runEdit(root: string, input: Record<string, unknown>, permission?: HubBertToolPermissionContext, signal?: AbortSignal): Promise<string> {
  const mode = await resolveToolMode('edit', input, permission, signal);
  const filePath = required(input.file_path, 'file_path');
  const edits = parseEditItems(input);
  const target = resolveToolPath(root, filePath, mode);
  let content = readFileSync(target, 'utf8');
  const batch = input.edits !== undefined;
  edits.forEach((item, index) => {
    const label = batch ? `edits[${index}] ` : '';
    const occurrences = countOccurrences(content, item.oldString);
    if (occurrences === 0) throw new Error(`${label}未找到 old_string`);
    if (!item.replaceAll && occurrences > 1) throw new Error(`${label}old_string 出现 ${occurrences} 次，请提供更具体的匹配或设置 replace_all 为 true`);
    content = item.replaceAll ? content.split(item.oldString).join(item.newString) : content.replace(item.oldString, item.newString);
  });
  fsWriteFileSync(target, content, 'utf8');
  if (batch) return `The file ${filePath} has been updated with ${edits.length} edit${edits.length === 1 ? '' : 's'}.`;
  return `The file ${filePath} has been updated${edits[0].replaceAll ? '. All occurrences were successfully replaced.' : ' successfully.'}`;
}

async function runMove(root: string, input: Record<string, unknown>, permission?: HubBertToolPermissionContext, signal?: AbortSignal): Promise<string> {
  const mode = await resolveToolMode('move', input, permission, signal);
  const source = required(input.source, 'source');
  const destination = required(input.destination, 'destination');
  const overwrite = Boolean(input.overwrite);
  const from = resolveToolPath(root, source, mode);
  const to = resolveToolPath(root, destination, mode);
  if (!existsSync(from)) throw new Error(`源路径不存在：${source}`);
  if (existsSync(to) && !overwrite) throw new Error(`目标已存在：${destination}；如需覆盖请设置 overwrite 为 true`);
  mkdirSync(dirname(to), { recursive: true });
  throwIfToolAborted(signal);
  await rename(from, to);
  return `Moved ${source} to ${destination}`;
}

async function runDelete(root: string, input: Record<string, unknown>, permission?: HubBertToolPermissionContext, signal?: AbortSignal): Promise<string> {
  const mode = await resolveToolMode('delete', input, permission, signal);
  const path = required(input.path, 'path');
  const recursive = Boolean(input.recursive);
  const target = resolveToolPath(root, path, mode);
  if (!existsSync(target)) throw new Error(`路径不存在：${path}`);
  const info = lstatSync(target);
  if (info.isDirectory() && !recursive) throw new Error(`${path} 是目录；删除目录请将 recursive 设为 true`);
  throwIfToolAborted(signal);
  await rm(target, { recursive, force: false });
  return `Deleted ${path}`;
}

function runTodoWrite(input: Record<string, unknown>): string {
  const raw = input.todos;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('todos 必须是非空数组');
  const statuses = new Set(['pending', 'in_progress', 'completed']);
  const marks: Record<string, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  const lines = raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`todos[${index}] 必须是对象`);
    const todo = item as Record<string, unknown>;
    const content = required(todo.content, `todos[${index}].content`);
    const status = string(todo.status);
    if (!statuses.has(status)) throw new Error(`todos[${index}].status 必须是 pending、in_progress 或 completed`);
    return `${marks[status]} ${content}`;
  });
  return cap(`已更新任务清单（${lines.length} 项）：\n${lines.join('\n')}`);
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
  const result = await executeBash(command, cwd, timeoutMs, signal);
  const out = cap(result.stdout);
  const err = cap(result.stderr);
  return [out, err].filter(Boolean).join('\n') || '(no output)';
}

interface BashResult { stdout: string; stderr: string; }

class ToolExecutionError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolExecutionError';
  }
}

function executeBash(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<BashResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('bash', ['-c', command], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: BashResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectResult(error); else resolveResult(result || { stdout, stderr });
    };
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* the process may have exited between close and kill */ }
    };
    const onAbort = () => { kill(); finish(signal?.reason instanceof Error ? signal.reason : new Error('Tool execution aborted')); };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const value = chunk.toString('utf8');
      if (kind === 'stdout') stdout += value; else stderr += value;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT * 8 || Buffer.byteLength(stderr) > MAX_OUTPUT * 8) {
        kill();
        finish(new ToolExecutionError('BASH_OUTPUT_LIMIT', `bash 输出超过 ${MAX_OUTPUT * 8} 字节限制`));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => finish(new ToolExecutionError('BASH_SPAWN_FAILED', `bash 启动失败：${error.message}`, { cause: error })));
    child.once('close', (code, terminationSignal) => {
      if (settled) return;
      if (code === 0 && !terminationSignal) return finish(undefined, { stdout, stderr });
      const detail = terminationSignal ? `被信号 ${terminationSignal} 终止` : `退出码 ${code ?? 'unknown'}`;
      finish(new ToolExecutionError(terminationSignal ? 'BASH_SIGNAL' : 'BASH_NONZERO_EXIT', `bash 执行失败：${detail}${stderr ? `：${cap(stderr)}` : ''}`));
    });
    timer = setTimeout(() => { kill(); finish(new ToolExecutionError('BASH_TIMEOUT', `bash 执行超时（${timeoutMs}ms）`)); }, timeoutMs);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  if (currentMode === 'read-only' && (toolName === 'write' || toolName === 'edit' || toolName === 'move' || toolName === 'delete')) return 'workspace-write';
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
  let realRoot: string;
  try { realRoot = realpathSync.native(root); } catch (error) {
    throw new Error(`无法验证工作区路径：${error instanceof Error ? error.message : String(error)}`);
  }
  const existing = nearestExistingPath(resolved);
  let realExisting: string;
  try { realExisting = realpathSync.native(existing); } catch (error) {
    throw new Error(`无法验证目标路径：${candidate || '.'}`);
  }
  if (!isWithin(realRoot, realExisting)) {
    throw new SandboxPermissionRequiredError('danger-full-access', `路径超出当前工作区范围，需要 danger-full-access 权限：${candidate}`);
  }
  if (existsSync(resolved)) {
    let realTarget: string;
    try { realTarget = realpathSync.native(resolved); } catch {
      throw new Error(`无法验证目标路径：${candidate || '.'}`);
    }
    if (!isWithin(realRoot, realTarget)) {
      throw new SandboxPermissionRequiredError('danger-full-access', `路径符号链接超出当前工作区范围，需要 danger-full-access 权限：${candidate}`);
    }
  }
  return resolved;
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (true) {
    try { lstatSync(current); return current; } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isWithin(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
}

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

async function runWebSearch(input: Record<string, unknown>, signal?: AbortSignal, delegatedSearch?: (query: string, signal?: AbortSignal) => Promise<string>): Promise<string> {
  const query = required(input.query, 'query');
  if (delegatedSearch) return delegatedSearch(query, signal);
  const endpoint = process.env.HARBORS_WEB_SEARCH_URL;
  if (!endpoint) throw new Error('未配置 web_search：请先在 Model Service 中配置可用 Provider');
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

async function runWebFetch(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const url = required(input.url, 'url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('web_fetch 只接受有效的 HTTP(S) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('web_fetch 只接受 HTTP(S) URL');
  let redirects = 0;
  while (true) {
    const response = await requestWeb(parsed, signal);
    if (isRedirect(response.statusCode)) {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      response.discard();
      if (!location) throw new ToolExecutionError('WEB_INVALID_REDIRECT', `web_fetch 收到无 Location 的重定向（HTTP ${response.statusCode}）`);
      if (redirects >= WEB_MAX_REDIRECTS) throw new ToolExecutionError('WEB_REDIRECT_LIMIT', `web_fetch 重定向超过 ${WEB_MAX_REDIRECTS} 跳限制`);
      try { parsed = new URL(location, parsed); } catch { throw new ToolExecutionError('WEB_INVALID_REDIRECT', 'web_fetch 重定向目标无效'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ToolExecutionError('WEB_INVALID_REDIRECT', 'web_fetch 重定向目标不是 HTTP(S) URL');
      redirects += 1;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.discard();
      throw new ToolExecutionError('WEB_HTTP_ERROR', `web_fetch 请求失败（HTTP ${response.statusCode}）`);
    }
    const contentTypeHeader = response.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(';') : contentTypeHeader || '';
    const body = await response.text();
    const text = contentType.includes('html') ? htmlToText(body) : body;
    return cap(`<url>${parsed.toString()}</url>\n<content>\n${text.slice(0, WEB_MAX_BODY_CHARS)}\n</content>`);
  }
}

interface WebResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
  discard(): void;
}

function isRedirect(statusCode: number): boolean { return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308; }

async function requestWeb(url: URL, parentSignal?: AbortSignal): Promise<WebResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  await resolveAndValidateHost(hostname);
  const timeoutSignal = requestTimeoutSignal(parentSignal, WEB_TIMEOUT_MS);
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname || '/'}${url.search}`,
      method: 'GET',
      headers: { accept: 'text/html, text/plain, application/json' },
      ...(url.protocol === 'https:' ? { servername: hostname } : {}),
      lookup: (host, options, callback) => {
        resolveAndValidateHost(host).then((addresses) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }).catch((error) => callback(error instanceof Error ? error : new Error(String(error)), options.all ? [] : '', 0));
      },
    }, (response) => {
      if (settled) return;
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > WEB_MAX_BODY_BYTES) {
        response.destroy();
        settled = true;
        rejectResponse(new ToolExecutionError('WEB_BODY_LIMIT', `web_fetch 响应超过 ${WEB_MAX_BODY_BYTES} 字节限制`));
        return;
      }
      const text = () => readWebBody(response, timeoutSignal);
      const discard = () => { response.resume(); };
      settled = true;
      timeoutSignal.removeEventListener('abort', onAbort);
      resolveResponse({ statusCode: response.statusCode || 0, headers: response.headers, text, discard });
    });
    const onAbort = () => request.destroy(timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error('web_fetch 请求已取消'));
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
    request.once('error', (error) => {
      timeoutSignal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (parentSignal?.aborted) rejectResponse(parentSignal.reason instanceof Error ? parentSignal.reason : new Error('Tool execution aborted'));
      else if (timeoutSignal.aborted) rejectResponse(new ToolExecutionError('WEB_TIMEOUT', `web_fetch 请求超时（${WEB_TIMEOUT_MS}ms）`, { cause: error }));
      else rejectResponse(new ToolExecutionError('WEB_NETWORK_ERROR', `web_fetch 网络请求失败：${error.message}`, { cause: error }));
    });
    request.end();
  });
}

function readWebBody(response: import('node:http').IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) rejectBody(error); else resolveBody(Buffer.concat(chunks).toString('utf8'));
    };
    const onAbort = () => { response.destroy(); finish(signal.reason instanceof Error ? signal.reason : new Error('web_fetch 请求已取消')); };
    signal.addEventListener('abort', onAbort, { once: true });
    response.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > WEB_MAX_BODY_BYTES) {
        response.destroy();
        finish(new ToolExecutionError('WEB_BODY_LIMIT', `web_fetch 响应超过 ${WEB_MAX_BODY_BYTES} 字节限制`));
      } else chunks.push(value);
    });
    response.once('end', () => finish());
    response.once('error', (error) => finish(new ToolExecutionError('WEB_NETWORK_ERROR', `web_fetch 读取响应失败：${error.message}`, { cause: error })));
  });
}

async function resolveAndValidateHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
  const ipFamily = isIP(normalized);
  if (ipFamily) {
    if (isRestrictedAddress(normalized)) throw new ToolExecutionError('WEB_SSRF_BLOCKED', 'web_fetch 拒绝访问受限网络地址');
    return [{ address: normalized, family: ipFamily }];
  }
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new ToolExecutionError('WEB_SSRF_BLOCKED', 'web_fetch 拒绝访问本地主机地址');
  }
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(normalized, { all: true, verbatim: true }); } catch (error) {
    throw new ToolExecutionError('WEB_DNS_ERROR', `web_fetch 无法解析目标地址：${normalized}`, { cause: error });
  }
  if (!addresses.length || addresses.some((entry) => isRestrictedAddress(entry.address))) {
    throw new ToolExecutionError('WEB_SSRF_BLOCKED', 'web_fetch 拒绝访问解析到受限网络地址');
  }
  return addresses;
}

function isRestrictedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const octets = normalized.split('.').map(Number);
    const value = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
    const inRange = (start: number, end: number) => value >= start && value <= end;
    return inRange(0x00000000, 0x00ffffff) || inRange(0x0a000000, 0x0affffff) || inRange(0x64400000, 0x647fffff)
      || inRange(0x7f000000, 0x7fffffff) || inRange(0xa9fe0000, 0xa9feffff) || inRange(0xac100000, 0xac1fffff)
      || inRange(0xc0000000, 0xc00000ff) || inRange(0xc0000200, 0xc00002ff) || inRange(0xc0000220, 0xc000022f)
      || inRange(0xc0000230, 0xc000023f) || inRange(0xc6120000, 0xc613ffff) || inRange(0xc6336400, 0xc63364ff)
      || inRange(0xcb007100, 0xcb0071ff) || inRange(0xc0a80000, 0xc0a8ffff)
      || inRange(0xe0000000, 0xffffffff);
  }
  if (family !== 6) return true;
  const value = ipv6ToBigInt(normalized);
  if (value === 0n || value === 1n) return true;
  if ((value >> 121n) === 0x7en || (value >> 118n) === 0x3fan || (value >> 120n) === 0xffn) return true;
  if ((value >> 96n) === 0x20010db8n || (value >> 96n) === 0x20010000n || (value >> 96n) === 0x20010010n) return true;
  const mapped = value >> 32n;
  return mapped === 0xffffn && isRestrictedAddress(`${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`);
}

function ipv6ToBigInt(value: string): bigint {
  const [head, tail] = value.split('::');
  const expandIpv4 = (words: string[]) => words.flatMap((word) => {
    if (!word.includes('.')) return [word];
    const octets = word.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return [];
    return [`${((octets[0] << 8) | octets[1]).toString(16)}`, `${((octets[2] << 8) | octets[3]).toString(16)}`];
  });
  const left = expandIpv4(head ? head.split(':').filter(Boolean) : []);
  const right = expandIpv4(tail ? tail.split(':').filter(Boolean) : []);
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (words.length !== 8) return 0n;
  try { return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n); } catch { return 0n; }
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
