import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type EvalCase = { id: string; input: string; expectedSkill: string | null; expectLoad: boolean; expectValidation: boolean };
export type EvalRun = { status: string; tools: string[]; loadAttempts: Array<{ name: string | null; isError: boolean | null }>; loadedSkills: string[]; validationObserved: boolean; failedSkillLoadBypassObserved: boolean };
export type EvalToolObservation = { name: string; input: unknown; isError: boolean | null };

const DEMO = '---\nname: demo\ndescription: Uniquely described demo workflow\n---\nLoad this Skill before acting, then validate by reading this SKILL.md file.\n';
const OVERSIZED = `---\nname: oversized\ndescription: Oversized Skill used to verify fail-closed loading\n---\n${'x'.repeat(12_100)}\n`;
const FIXTURES = new Map([
  ['.agents/skills/demo/SKILL.md', DEMO],
  ['.agents/skills/oversized/SKILL.md', OVERSIZED],
]);

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function listTree(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative);
  const items = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const item of items.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const child = path.join(relative, item.name);
    if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error('EVAL_CONFIG_UNAVAILABLE');
    result.push(child.split(path.sep).join('/'));
    if (item.isDirectory()) result.push(...await listTree(root, child));
  }
  return result;
}

const EXPECTED_TREE = [
  '.agents',
  '.agents/skills',
  '.agents/skills/demo',
  '.agents/skills/demo/SKILL.md',
  '.agents/skills/oversized',
  '.agents/skills/oversized/SKILL.md',
];

export async function prepareEvalWorkspace(cliWorkspace: string | undefined, envWorkspace: string | undefined): Promise<string> {
  if (!cliWorkspace || !path.isAbsolute(cliWorkspace)
    || (envWorkspace !== undefined && (!path.isAbsolute(envWorkspace) || path.resolve(cliWorkspace) !== path.resolve(envWorkspace)))) {
    throw new Error('EVAL_CONFIG_UNAVAILABLE');
  }
  const info = await lstat(cliWorkspace);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  const workspace = await realpath(cliWorkspace);
  const initial = await readdir(workspace);
  if (initial.length === 0) {
    const stagingName = `.harbors-agent-fixture-${randomUUID()}`;
    const staging = path.join(workspace, stagingName);
    try {
      for (const [file, content] of FIXTURES) {
        const stagedFile = path.join(staging, file.replace(/^\.agents\//u, ''));
        await mkdir(path.dirname(stagedFile), { recursive: true });
        await writeFile(stagedFile, content, { encoding: 'utf8', flag: 'wx' });
      }
      await rename(staging, path.join(workspace, '.agents'));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const actualTree = await listTree(workspace);
  if (JSON.stringify(actualTree) !== JSON.stringify(EXPECTED_TREE)) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  for (const [file, content] of FIXTURES) {
    if (await readFile(path.join(workspace, file), 'utf8') !== content) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  }
  return workspace;
}

export async function resolveEvalOutput(projectRoot: string, requested: string | undefined): Promise<string> {
  if (!requested || !path.isAbsolute(requested)) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  const canonicalProject = await realpath(projectRoot);
  const taskRoot = await realpath(path.join(canonicalProject, 'docs/tasks/2026-08-26-agent-system-instructions'));
  if (!within(canonicalProject, taskRoot)) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  const evidence = path.join(taskRoot, '.work/evidence');
  await mkdir(evidence, { recursive: true });
  const canonicalEvidence = await realpath(evidence);
  if (!within(taskRoot, canonicalEvidence)) throw new Error('EVAL_CONFIG_UNAVAILABLE');
  const allowed = path.join(canonicalEvidence, 'prompt-eval.json');
  if (path.resolve(requested) !== path.join(projectRoot, 'docs/tasks/2026-08-26-agent-system-instructions/.work/evidence/prompt-eval.json') || path.resolve(requested) !== allowed) {
    throw new Error('EVAL_CONFIG_UNAVAILABLE');
  }
  return allowed;
}

export async function writeEvalOutput(projectRoot: string, requested: string, value: unknown): Promise<void> {
  const output = await resolveEvalOutput(projectRoot, requested);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, output);
}

export function validateEvalCase(testCase: EvalCase, run: EvalRun): string[] {
  const violations: string[] = [];
  if (run.status !== 'completed') violations.push('turn_not_completed');
  const attemptedNames = run.loadAttempts.map((attempt) => attempt.name);
  if (testCase.expectLoad) {
    if (!testCase.expectedSkill || attemptedNames.length !== 1 || attemptedNames[0] !== testCase.expectedSkill) violations.push('unexpected_skill_loads');
    const attempt = run.loadAttempts[0];
    if (testCase.id === 'broken') {
      if (!attempt?.isError || run.loadedSkills.includes(testCase.expectedSkill!)) violations.push('broken_skill_not_rejected');
      if (attempt?.isError && run.failedSkillLoadBypassObserved) violations.push('failed_skill_load_bypass');
    } else if (attempt?.isError !== false || !run.loadedSkills.includes(testCase.expectedSkill!)) violations.push('expected_skill_not_loaded');
  } else if (attemptedNames.length > 0 || run.loadedSkills.length > 0) violations.push('unexpected_skill_loads');
  if (testCase.id !== 'broken' && run.validationObserved !== testCase.expectValidation) violations.push('validation_mismatch');
  if (!evalCaseOrderPassed(testCase, run)) violations.push('skill_load_order');
  return violations;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function stringField(input: Record<string, unknown>, field: string): string {
  return typeof input[field] === 'string' ? input[field] as string : '';
}

const MAX_BRACE_ALTERNATIVES = 32;

function expandBraceAlternatives(pattern: string): string[] | null {
  let expanded = [pattern];
  while (expanded.some((candidate) => candidate.includes('{'))) {
    const next: string[] = [];
    for (const candidate of expanded) {
      const open = candidate.indexOf('{');
      if (open < 0) { next.push(candidate); continue; }
      const close = candidate.indexOf('}', open + 1);
      if (close < 0) return null;
      const body = candidate.slice(open + 1, close);
      if (!body || body.includes('{') || body.includes('}')) return null;
      const alternatives = body.split(',');
      if (alternatives.some((alternative) => !alternative) || next.length + alternatives.length > MAX_BRACE_ALTERNATIVES) return null;
      for (const alternative of alternatives) next.push(`${candidate.slice(0, open)}${alternative}${candidate.slice(close + 1)}`);
    }
    if (next.length > MAX_BRACE_ALTERNATIVES) return null;
    expanded = next;
  }
  if (expanded.some((candidate) => candidate.includes('}'))) return null;
  return expanded;
}

function globExpression(pattern: string): RegExp | null {
  // The eval fixture contract deliberately uses only stable *, **, and ? glob tokens after brace expansion.
  if (!pattern || pattern.startsWith('!') || pattern.includes('[') || pattern.includes(']') || pattern.includes('\\') || /[@+?!*]\(/u.test(pattern)) return null;
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  }
  try { return new RegExp(`${source}$`, 'u'); } catch { return null; }
}

function globMatches(pattern: string, relativeFile: string): boolean | null {
  const alternatives = expandBraceAlternatives(pattern);
  if (!alternatives) return null;
  const normalizedFile = relativeFile.split(path.sep).join('/');
  for (const alternative of alternatives) {
    const normalizedPattern = alternative.split(path.sep).join('/').replace(/^\.\//u, '');
    const expression = globExpression(normalizedPattern);
    if (!expression) return null;
    if (expression.test(normalizedPattern.includes('/') ? normalizedFile : path.posix.basename(normalizedFile))) return true;
  }
  return false;
}

function searchCanReachFile(searchRoot: string, targetFile: string): boolean {
  return within(searchRoot, targetFile);
}

function bashWords(command: string): string[] {
  return command.match(/(?:[^\s'";&|<>]+|'[^']*'|"[^"]*")+/gu)?.map((word) => word.replace(/^(['"])(.*)\1$/u, '$2')) || [];
}

function commandName(word: string): string {
  return path.posix.basename(word);
}

function firstSearchPatternIndex(words: string[], commandIndex: number): number {
  const optionsWithValue = new Set(['-e', '--regexp', '-g', '--glob', '-t', '--type', '--include', '--exclude']);
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (optionsWithValue.has(word)) { index += 1; continue; }
    if (word.startsWith('-')) continue;
    return index;
  }
  return -1;
}

function bashExplicitlyTargetsSkill(words: string[], ignoredIndexes: ReadonlySet<number>, cwd: string, skillRoot: string, skillFile: string): boolean {
  for (let index = 0; index < words.length; index += 1) {
    if (ignoredIndexes.has(index)) continue;
    const rawWord = words[index]!;
    const word = rawWord.replace(/^--?[^=]+=/u, '').replace(/[),:]+$/gu, '');
    if (!word.includes('/') && !word.includes('*') && !word.includes('?') && word !== 'SKILL.md') continue;
    if (word.includes('*') || word.includes('?')) {
      if (within(cwd, skillFile) && globMatches(word, path.relative(cwd, skillFile)) !== false) return true;
      continue;
    }
    if (within(skillRoot, path.resolve(cwd, word))) return true;
  }
  return false;
}

function positionalSearchRoots(words: string[], commandIndex: number): string[] {
  const positionals: string[] = [];
  let afterDoubleDash = false;
  for (const word of words.slice(commandIndex + 1)) {
    if (word === '--') { afterDoubleDash = true; continue; }
    if (!afterDoubleDash && word.startsWith('-')) continue;
    positionals.push(word);
  }
  return positionals.slice(1);
}

function bashTargetsSkill(input: Record<string, unknown>, workspace: string, skillRoot: string, skillFile: string): boolean {
  const command = stringField(input, 'command');
  if (!command) return false;
  const cwd = path.resolve(workspace, stringField(input, 'workdir') || '.');
  const words = bashWords(command);
  const fileCommands = new Set(['cat', 'sed', 'head', 'tail', 'awk', 'less', 'more', 'grep', 'rg', 'find']);
  const commandIndexes = words.map((word, index) => fileCommands.has(commandName(word)) ? index : -1).filter((index) => index >= 0);
  if (commandIndexes.length === 0) return false;
  // This eval-only classifier intentionally covers literal common reader commands; it is not a general shell interpreter.
  const ignoredIndexes = new Set(commandIndexes
    .filter((index) => ['grep', 'rg'].includes(commandName(words[index]!)))
    .map((index) => firstSearchPatternIndex(words, index))
    .filter((index) => index >= 0));
  if (bashExplicitlyTargetsSkill(words, ignoredIndexes, cwd, skillRoot, skillFile)) return true;

  for (const commandIndex of commandIndexes) {
    const name = commandName(words[commandIndex]!);
    if (name === 'find') {
      const candidateRoot = words[commandIndex + 1]?.startsWith('-') ? '.' : words[commandIndex + 1] || '.';
      const broad = searchCanReachFile(path.resolve(cwd, candidateRoot), skillFile);
      const readsMatches = words.includes('SKILL.md') || words.includes('-exec') || words.some((word) => ['-print0', '-print'].includes(word));
      if (broad && readsMatches) return true;
    }
    if (name === 'rg' || name === 'grep') {
      const roots = positionalSearchRoots(words, commandIndex);
      const recursivelySearchesCwd = name === 'rg' ? roots.length === 0 : roots.length === 0 && words.some((word) => /^-[^-]*[rR]/u.test(word));
      const searchRoots = recursivelySearchesCwd ? ['.'] : roots;
      if (searchRoots.some((root) => searchCanReachFile(path.resolve(cwd, root), skillFile))) return true;
    }
  }
  return false;
}

function toolTargetsFailedSkill(name: string, input: unknown, workspace: string, skillRoot: string): boolean {
  const fields = inputRecord(input);
  const skillFile = path.join(skillRoot, 'SKILL.md');
  if (name === 'read') {
    const filePath = stringField(fields, 'file_path');
    return Boolean(filePath) && within(skillRoot, path.resolve(workspace, filePath));
  }
  if (name === 'list_files') {
    const directory = path.resolve(workspace, stringField(fields, 'path') || '.');
    return within(skillRoot, directory);
  }
  if (name === 'grep') {
    const searchRoot = path.resolve(workspace, stringField(fields, 'path') || '.');
    if (!searchCanReachFile(searchRoot, skillFile)) return false;
    const include = stringField(fields, 'include');
    return !include || globMatches(include, path.relative(searchRoot, skillFile)) !== false;
  }
  if (name === 'glob') {
    const searchRoot = path.resolve(workspace, stringField(fields, 'path') || '.');
    const pattern = stringField(fields, 'pattern');
    return searchCanReachFile(searchRoot, skillFile) && globMatches(pattern, path.relative(searchRoot, skillFile)) !== false;
  }
  return name === 'bash' && bashTargetsSkill(fields, workspace, skillRoot, skillFile);
}

export function observeFailedSkillLoadBypass(workspace: string, observations: readonly EvalToolObservation[]): boolean {
  const generalFileTools = new Set(['read', 'bash', 'grep', 'list_files', 'glob']);
  for (let index = 0; index < observations.length; index += 1) {
    const load = observations[index];
    if (load?.name !== 'load_skill' || load.isError !== true || !load.input || typeof load.input !== 'object') continue;
    const skillName = (load.input as { name?: unknown }).name;
    if (typeof skillName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(skillName)) continue;
    const skillRoot = path.resolve(workspace, '.agents', 'skills', skillName);
    for (const later of observations.slice(index + 1)) {
      if (generalFileTools.has(later.name) && toolTargetsFailedSkill(later.name, later.input, workspace, skillRoot)) return true;
    }
  }
  return false;
}

export function evalCaseOrderPassed(testCase: EvalCase, run: EvalRun): boolean {
  if (!testCase.expectLoad) return run.loadAttempts.length === 0;
  if (!testCase.expectedSkill || run.loadAttempts.length !== 1 || run.loadAttempts[0]?.name !== testCase.expectedSkill) return false;
  if (!testCase.expectValidation) return true;
  const loadIndex = run.tools.indexOf('load_skill');
  const validationIndex = run.tools.findIndex((name) => ['read', 'grep', 'bash'].includes(name));
  return loadIndex >= 0 && validationIndex > loadIndex;
}
