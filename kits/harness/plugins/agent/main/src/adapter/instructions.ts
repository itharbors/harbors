/**
 * 工作区指令（AGENTS.md）发现与注入。
 *
 * 借鉴 DeepSeek Harness 的 agent-instructions 设计：
 * - 从会话 cwd 向上找到项目根（含 .git 的目录），再从根到 cwd 逐层收集 AGENTS.md；
 * - 附加用户全局 `~/.agents/AGENTS.md`，优先级最低（最宽泛）；
 * - 顺序从宽到窄（越具体越靠后、优先级越高），拼进一个 <system-reminder> 帧；
 * - 有总字节预算，超出时从最宽泛的开始丢弃，最后对最具体的一份做截断。
 *
 * 与原版不同：不依赖 DeepSeek 私有框架，仅用 Node fs；注入为 system 角色而非 surface 消息。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const INSTRUCTION_FILE = 'AGENTS.md';
const PROJECT_ROOT_MARKERS = ['.git'] as const;
const DEFAULT_MAX_BYTES = 32_768;
const MAX_SOURCE_BYTES = 1_048_576;
const USER_GLOBAL_DISPLAY = '~/.agents/AGENTS.md';

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const WORKSPACE_CONTEXT_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.';

interface LoadedInstruction {
  displayPath: string;
  content: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function existsMarker(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 从 cwd 向上找到第一个含根标记（.git）的目录；找不到则返回 cwd。 */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (await existsMarker(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** 构造从 root 到 cwd 的目录链（从宽到窄）。 */
function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = [];
  let current = resolve(cwd);
  const resolvedRoot = resolve(root);
  while (current !== resolvedRoot) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.push(resolvedRoot);
  return chain.reverse();
}

/** 读取一个 AGENTS.md，超过单文件上限或为空则忽略。 */
async function readInstruction(path: string, displayPath: string): Promise<LoadedInstruction | undefined> {
  if (!(await isFile(path))) return undefined;
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  if (byteLength(content) > MAX_SOURCE_BYTES) return undefined;
  if (!content.trim()) return undefined;
  return { displayPath, content };
}

/**
 * 发现并读取工作区指令，返回从宽到窄排序、按内容去重后的列表。
 * 顺序：用户全局 → 项目根 → …… → cwd。
 */
async function discoverInstructions(workspace: string): Promise<LoadedInstruction[]> {
  const cwd = resolve(workspace);
  const loaded: LoadedInstruction[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();

  const push = (file: LoadedInstruction | undefined, absolutePath: string): void => {
    if (!file) return;
    if (seenPaths.has(absolutePath)) return;
    seenPaths.add(absolutePath);
    const digest = file.content.trim();
    if (seenContent.has(digest)) return;
    seenContent.add(digest);
    loaded.push(file);
  };

  // 用户全局（最宽泛）。
  const userGlobal = join(homedir(), '.agents', INSTRUCTION_FILE);
  push(await readInstruction(userGlobal, USER_GLOBAL_DISPLAY), userGlobal);

  // 项目根到 cwd，从宽到窄。
  const projectRoot = await findProjectRoot(cwd);
  for (const dir of ancestorChain(projectRoot, cwd)) {
    const abs = join(dir, INSTRUCTION_FILE);
    const display = relative(projectRoot, abs) || INSTRUCTION_FILE;
    push(await readInstruction(abs, display), abs);
  }

  return loaded;
}

function sectionText(file: LoadedInstruction): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content.trim()}`;
}

function escapeFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
}

function frame(body: string): string {
  return [SYSTEM_REMINDER_OPEN, escapeFrameBody(body), SYSTEM_REMINDER_CLOSE].join('\n');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * 在字节预算内渲染指令。超预算时先从最宽泛处丢弃，最后对最具体的一份做截断。
 * @returns 注入文本；无可用指令或预算不足时返回 undefined。
 */
function renderInstructions(files: LoadedInstruction[], maxBytes: number): string | undefined {
  if (files.length === 0 || maxBytes <= 0) return undefined;

  const build = (included: LoadedInstruction[]): string =>
    frame([WORKSPACE_CONTEXT_INTRO, ...included.map(sectionText)].join('\n\n'));

  const full = build(files);
  if (byteLength(full) <= maxBytes) return full;

  // 从最宽泛的开始丢弃，保留尽可能多的具体指令。
  for (let start = 1; start < files.length; start += 1) {
    const suffix = build(files.slice(start));
    if (byteLength(suffix) <= maxBytes) return suffix;
  }

  // 只剩最具体的一份仍超预算：对其内容二分截断。
  const mostSpecific = files[files.length - 1];
  const original = mostSpecific.content.trim();
  let low = 0;
  let high = byteLength(original);
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(original, mid);
    const text = build([{ ...mostSpecific, content: candidate }]);
    if (byteLength(text) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return build([{ ...mostSpecific, content: best }]);
  return undefined;
}

/**
 * 加载并渲染工作区指令，供注入模型上下文。
 * @param workspace - 会话工作目录。
 * @param maxBytes - 注入文本的字节上限，默认 32KB。
 * @returns 已包 <system-reminder> 帧的注入文本；无指令时返回 undefined。
 */
export async function loadWorkspaceInstructions(workspace: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<string | undefined> {
  try {
    const files = await discoverInstructions(workspace);
    return renderInstructions(files, maxBytes);
  } catch {
    // 指令加载失败不应中断对话。
    return undefined;
  }
}
