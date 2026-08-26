import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evalCaseOrderPassed, observeFailedSkillLoadBypass, prepareEvalWorkspace, resolveEvalOutput, validateEvalCase, writeEvalOutput, type EvalRun, type EvalToolObservation } from './prompt-eval.contract.ts';

test('eval workspace is materialized once and rejects any non-fixture entry', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-eval-contract-'));
  const canonicalWorkspace = await realpath(workspace);
  assert.equal(await prepareEvalWorkspace(workspace, undefined), canonicalWorkspace);
  assert.equal(await prepareEvalWorkspace(workspace, workspace), canonicalWorkspace);
  await writeFile(path.join(workspace, 'injected.txt'), 'not allowed');
  await assert.rejects(prepareEvalWorkspace(workspace, workspace), /EVAL_CONFIG_UNAVAILABLE/);
  await assert.rejects(prepareEvalWorkspace(workspace, `${workspace}-other`), /EVAL_CONFIG_UNAVAILABLE/);
});

test('eval output is the one canonical Task evidence filename only', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '../../../../..');
  const allowed = path.join(projectRoot, 'docs/tasks/2026-08-26-agent-system-instructions/.work/evidence/prompt-eval.json');
  assert.equal(await resolveEvalOutput(projectRoot, allowed), allowed);
  await assert.rejects(resolveEvalOutput(projectRoot, path.join(path.dirname(allowed), 'other.json')), /EVAL_CONFIG_UNAVAILABLE/);
  await assert.rejects(resolveEvalOutput(projectRoot, path.join(path.dirname(allowed), '../prompt-eval.json')), /EVAL_CONFIG_UNAVAILABLE/);
});

test('eval output atomically replaces only prompt-eval.json and is safely rerunnable', async () => {
  const temporaryProject = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-eval-output-')));
  const evidence = path.join(temporaryProject, 'docs/tasks/2026-08-26-agent-system-instructions/.work/evidence');
  await mkdir(evidence, { recursive: true });
  const output = path.join(evidence, 'prompt-eval.json');
  await writeEvalOutput(temporaryProject, output, { run: 1 });
  await writeEvalOutput(temporaryProject, output, { run: 2 });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { run: 2 });
  assert.deepEqual((await readdir(evidence)).sort(), ['prompt-eval.json']);
});

test('per-case contract rejects extra loads, wrong order, and validation mismatch', () => {
  const valid: EvalRun = {
    status: 'completed',
    tools: ['load_skill', 'read'],
    loadAttempts: [{ name: 'demo', isError: false }],
    loadedSkills: ['demo'],
    validationObserved: true,
    failedSkillLoadBypassObserved: false,
  };
  const demoCase = { id: 'explicit', input: '', expectedSkill: 'demo', expectLoad: true, expectValidation: true };
  assert.deepEqual(validateEvalCase(demoCase, valid), []);
  assert.equal(evalCaseOrderPassed(demoCase, valid), true);
  assert.deepEqual(validateEvalCase(demoCase, { ...valid, tools: ['read', 'load_skill'] }), ['skill_load_order']);
  assert.equal(evalCaseOrderPassed(demoCase, { ...valid, loadAttempts: [{ name: 'wrong', isError: false }] }), false);
  assert.ok(validateEvalCase(demoCase, { ...valid, loadAttempts: [...valid.loadAttempts, { name: 'extra', isError: false }] }).includes('unexpected_skill_loads'));
  assert.ok(validateEvalCase(demoCase, { ...valid, validationObserved: false }).includes('validation_mismatch'));
  const brokenCase = { id: 'broken', input: '', expectedSkill: 'oversized', expectLoad: true, expectValidation: false };
  const rejectedBroken: EvalRun = { status: 'completed', tools: ['load_skill'], loadAttempts: [{ name: 'oversized', isError: true }], loadedSkills: [], validationObserved: false, failedSkillLoadBypassObserved: false };
  assert.deepEqual(validateEvalCase(brokenCase, rejectedBroken), []);
  assert.deepEqual(validateEvalCase(brokenCase, { ...rejectedBroken, tools: ['load_skill', 'read'], validationObserved: true }), []);
  assert.deepEqual(validateEvalCase(brokenCase, { ...rejectedBroken, tools: ['load_skill', 'read'], validationObserved: true, failedSkillLoadBypassObserved: true }), ['failed_skill_load_bypass']);
});

test('failed Skill bypass detection is target-aware and traversal-safe', () => {
  const workspace = '/private/eval-workspace';
  const failedLoad: EvalToolObservation = { name: 'load_skill', input: { name: 'oversized' }, isError: true };
  const observed = (tool: EvalToolObservation) => observeFailedSkillLoadBypass(workspace, [failedLoad, tool]);

  assert.equal(observed({ name: 'read', input: { file_path: 'notes.txt' }, isError: false }), false);
  assert.equal(observed({ name: 'list_files', input: { path: '.agents/skills/oversized' }, isError: false }), true);
  assert.equal(observed({ name: 'read', input: { file_path: 'scratch/../.agents/skills/oversized/SKILL.md' }, isError: false }), true);
  assert.equal(observed({ name: 'bash', input: { command: 'cat .agents/skills/../skills/oversized/SKILL.md' }, isError: false }), true);
  assert.equal(observed({ name: 'grep', input: { pattern: '.agents/skills/oversized/SKILL.md', path: 'notes.txt' }, isError: false }), false);
  assert.equal(observed({ name: 'grep', input: { pattern: 'workflow' }, isError: false }), true);
  assert.equal(observed({ name: 'grep', input: { pattern: 'workflow', include: '*.{md,txt}' }, isError: false }), true);
  assert.equal(observed({ name: 'grep', input: { pattern: 'workflow', include: '*.{ts,js}' }, isError: false }), false);
  assert.equal(observed({ name: 'grep', input: { pattern: 'workflow', include: '*.[m]d' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/SKILL.md' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/{SKILL.md,README.md}' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/{README.md,guide.md}' }, isError: false }), false);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/[S]KILL.md' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '!**/README.md' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '@(README|SKILL).md' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: 'README.md' }, isError: false }), false);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/[S]KILL.md', path: '.agents/skills/demo' }, isError: false }), false);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/{{SKILL.md,README.md},notes.md}' }, isError: false }), true);
  assert.equal(observed({ name: 'glob', input: { pattern: '**/{a,b,c,d,e,f,g,h}{1,2,3,4,SKILL.md}' }, isError: false }), true);
  assert.equal(observed({ name: 'bash', input: { command: 'find . -name SKILL.md -exec cat {} +' }, isError: false }), true);
  assert.equal(observed({ name: 'bash', input: { command: 'rg workflow notes.txt' }, isError: false }), false);
  assert.equal(observed({ name: 'bash', input: { command: "grep '.agents/skills/oversized/SKILL.md' notes.txt" }, isError: false }), false);
  assert.equal(observed({ name: 'bash', input: { command: 'cat SKILL.md', workdir: '.agents/skills/oversized' }, isError: false }), true);
  assert.equal(observed({ name: 'bash', input: { command: 'echo .agents/skills/oversized/SKILL.md' }, isError: false }), false);
  assert.equal(observed({ name: 'read', input: { path: '.agents/skills/oversized/SKILL.md' }, isError: false }), false);
  assert.equal(observed({ name: 'grep', input: { pattern: 'workflow', path: '.', include: '*.ts' }, isError: false }), false);
  assert.equal(observeFailedSkillLoadBypass(workspace, [
    { name: 'load_skill', input: { name: 'demo' }, isError: false },
    { name: 'read', input: { file_path: '.agents/skills/demo/SKILL.md' }, isError: false },
  ]), false);
});
