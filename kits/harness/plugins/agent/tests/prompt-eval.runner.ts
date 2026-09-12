import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createKitAssemblyHarness } from '../../../../../packages/server/dist/testing.js';
import { ContextStore } from '../../agent-context-store/main/src/store.ts';
import { HarborsAdapter, type ContextStoreClient, type ModelServiceCatalog, type ModelServiceClient, type ModelServiceCompleteRequest, type TurnInstructionProvider } from '../main/src/adapter/harbors.ts';
import { loadWorkspaceInstructions } from '../main/src/adapter/instructions.ts';
import { discoverSkillCatalog } from '../main/src/adapter/skills.ts';
import { validateCustomInstructions } from '../main/src/adapter/system-instructions.ts';
import { evalCaseOrderPassed, observeFailedSkillLoadBypass, prepareEvalWorkspace, resolveEvalOutput, validateEvalCase, writeEvalOutput, type EvalCase, type EvalToolObservation } from './prompt-eval.contract.ts';
import { cleanupEvalResources, openEvalCredentialVault } from './prompt-eval.credentials.ts';

const execFileAsync = promisify(execFile);

function args(): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('INVALID_ARGUMENTS');
    result[key.slice(2)] = value;
  }
  return result;
}

function safeMessage(code: string): string {
  const messages: Record<string, string> = {
    EVAL_CONFIG_UNAVAILABLE: 'Dedicated Model Service evaluation configuration is unavailable.',
    EVAL_MODEL_UNAVAILABLE: 'The selected evaluation model is unavailable.',
    EVAL_PROVIDER_UNAVAILABLE: 'The configured evaluation provider or credential is unavailable.',
    EVAL_RUN_FAILED: 'The live evaluation did not complete all cases.',
  };
  return messages[code] || messages.EVAL_RUN_FAILED;
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function summarizeTrace(events: any[], promptVersion: string, workspace: string): any {
  const request = events.find((event) => event.type === 'request/context');
  const end = [...events].reverse().find((event) => event.type === 'turn/end');
  const toolCalls = events.filter((event) => event.type === 'tool/call');
  const tools = toolCalls.map((event) => event.data.name).filter((name) => typeof name === 'string');
  const results = new Map(events.filter((event) => event.type === 'tool/result').map((event) => [event.data.item?.snapshot?.callId, event.data.item?.snapshot?.isError]));
  const observations: EvalToolObservation[] = toolCalls.map((event) => ({
    name: typeof event.data.name === 'string' ? event.data.name : '',
    input: parseToolInput(event.data.arguments),
    isError: typeof results.get(event.data.callId) === 'boolean' ? results.get(event.data.callId) : null,
  }));
  const loadAttempts = observations.filter((observation) => observation.name === 'load_skill').map((observation) => ({
    name: observation.input && typeof observation.input === 'object' && typeof (observation.input as { name?: unknown }).name === 'string'
      ? (observation.input as { name: string }).name
      : null,
    isError: observation.isError,
  }));
  const usages = events.filter((event) => event.type === 'assistant/message').map((event) => event.data.usage).filter(Boolean);
  const usage = usages.reduce((total, current) => ({
    inputTokens: total.inputTokens + Number(current.inputTokens || 0),
    outputTokens: total.outputTokens + Number(current.outputTokens || 0),
    totalTokens: total.totalTokens + Number(current.totalTokens || 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    status: end?.data?.reason?.kind === 'completed' ? 'completed' : 'failed',
    promptVersion,
    promptDigest: request?.data?.promptDigest || null,
    tools,
    loadAttempts,
    loadedSkills: Array.isArray(end?.data?.loadedSkills) ? end.data.loadedSkills : [],
    validationObserved: tools.some((name) => ['read', 'grep', 'bash'].includes(name)),
    failedSkillLoadBypassObserved: observeFailedSkillLoadBypass(workspace, observations),
    usage,
  };
}

function publicRun(run: any): any {
  const { loadAttempts: _loadAttempts, failedSkillLoadBypassObserved: _failedSkillLoadBypassObserved, ...safe } = run;
  return safe;
}

async function runOne(adapter: HarborsAdapter, workspace: string, testCase: EvalCase, model: string, reasoningEffort?: string): Promise<any> {
  try {
    const conversation = await adapter.createConversation(workspace, { model, ...(reasoningEffort ? { reasoningEffort } : {}) });
    try { await adapter.sendMessage(conversation.id, testCase.input); } catch { /* trace carries the safe failure shape */ }
    return await adapter.getConversationTrace(conversation.id);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const options = args();
  const evalRoot = process.env.HARBORS_AGENT_EVAL_DATA_ROOT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '../../../../..');
  const requestedOutput = options.output ? path.resolve(options.output) : '';
  const output = await resolveEvalOutput(projectRoot, requestedOutput);
  let gitCommit = 'unknown';
  try { gitCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim(); } catch { /* safe blocked artifact */ }

  const result: any = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit,
    runtime: { providerSource: 'model-service-config', model: null, modelSource: null, reasoningEffort: null, reasoningSource: null },
    cases: [],
    summary: { completed: 0, total: 0 },
    blocked: null,
  };
  if (!evalRoot || !path.isAbsolute(evalRoot) || !options.workspace || !path.isAbsolute(options.workspace)) {
    result.blocked = { code: 'EVAL_CONFIG_UNAVAILABLE', message: safeMessage('EVAL_CONFIG_UNAVAILABLE') };
    await writeEvalOutput(projectRoot, output, result);
    process.exitCode = 2;
    return;
  }
  let harness: ReturnType<typeof createKitAssemblyHarness> | undefined;
  let credentialVault: Awaited<ReturnType<typeof openEvalCredentialVault>> | undefined;
  let baseline: HarborsAdapter | undefined;
  let candidate: HarborsAdapter | undefined;
  let baselineStore: ContextStore | undefined;
  let candidateStore: ContextStore | undefined;
  try {
    const workspace = await prepareEvalWorkspace(options.workspace, process.env.HARBORS_AGENT_WORKSPACE);
    credentialVault = await openEvalCredentialVault(path.resolve(evalRoot));
    harness = createKitAssemblyHarness({ projectRoot, kitDirectory: path.join(projectRoot, 'kits/harness'), kitName: 'harness', paths: { applicationData: path.resolve(evalRoot) }, credentials: credentialVault });
    await harness.kit.load();
    const client: ModelServiceClient = {
      getCatalog: () => harness!.messages.requestFrom('agent', 'model-service', 'getCatalog') as Promise<ModelServiceCatalog>,
      complete: (request: ModelServiceCompleteRequest) => harness!.messages.requestFrom('agent', 'model-service', 'complete', request) as ReturnType<ModelServiceClient['complete']>,
      cancel: (requestId: string) => harness!.messages.requestFrom('agent', 'model-service', 'cancel', { requestId }),
    };
    const catalog = await client.getCatalog();
    const model = options.model || catalog.defaultModel;
    const modelEntry = catalog.models.find((entry) => entry.id === model);
    if (!model || !modelEntry) throw new Error('EVAL_MODEL_UNAVAILABLE');
    const reasoningEffort = options['reasoning-effort'] || modelEntry.defaultReasoningEffort;
    result.runtime = {
      providerSource: 'model-service-config',
      model,
      modelSource: options.model ? 'cli' : 'catalog-default',
      reasoningEffort: reasoningEffort || null,
      reasoningSource: options['reasoning-effort'] ? 'cli' : reasoningEffort ? 'catalog-default' : 'model-default-omitted',
    };
    const cases = JSON.parse(await readFile(path.join(here, 'fixtures/skill-routing-cases.json'), 'utf8')) as EvalCase[];
    result.summary.total = cases.length;
    const baselineProvider: TurnInstructionProvider = async (caseWorkspace) => {
      const [system, skillCatalog] = await Promise.all([loadWorkspaceInstructions(caseWorkspace), discoverSkillCatalog(caseWorkspace)]);
      return {
        system,
        skillCatalog: { ...skillCatalog, text: skillCatalog.entries.map((entry) => entry.name).join('\n') },
        audit: {
          promptVersion: 'workspace-only/v0',
          promptDigest: `sha256:${createHash('sha256').update(system || '', 'utf8').digest('hex')}`,
          custom: { configured: false, applied: false, code: 'disabled' },
          workspace: { sources: [], omitted: 0, errors: 0 },
          skills: { total: 0, included: 0, omitted: 0, truncated: 0, errors: 0, shadowed: 0 },
        },
      };
    };
    baselineStore = new ContextStore(path.join(evalRoot, 'runner-baseline'));
    candidateStore = new ContextStore(path.join(evalRoot, 'runner-candidate'));
    baseline = new HarborsAdapter(client, baselineStore as unknown as ContextStoreClient, () => validateCustomInstructions(undefined), baselineProvider);
    candidate = new HarborsAdapter(client, candidateStore as unknown as ContextStoreClient);
    let evaluationFailed = false;
    for (const testCase of cases) {
      const baselineTrace = await runOne(baseline, workspace, testCase, model, reasoningEffort);
      const candidateTrace = await runOne(candidate, workspace, testCase, model, reasoningEffort);
      const baselineRun = summarizeTrace(baselineTrace, 'workspace-only/v0', workspace);
      const candidateRun = summarizeTrace(candidateTrace, 'harbors-agent-core/v1', workspace);
      const violations = validateEvalCase(testCase, candidateRun);
      if (baselineRun.status !== 'completed') baselineRun.status = 'blocked';
      if (violations.length > 0) candidateRun.status = 'blocked';
      result.cases.push({
        id: testCase.id,
        baseline: publicRun(baselineRun),
        candidate: publicRun(candidateRun),
        comparison: {
          skillHitDelta: Number(candidateRun.loadedSkills.includes(testCase.expectedSkill)) - Number(baselineRun.loadedSkills.includes(testCase.expectedSkill)),
          orderPassed: evalCaseOrderPassed(testCase, candidateRun),
          validationDelta: Number(candidateRun.validationObserved) - Number(baselineRun.validationObserved),
          inputTokenDelta: candidateRun.usage.inputTokens - baselineRun.usage.inputTokens,
          outputTokenDelta: candidateRun.usage.outputTokens - baselineRun.usage.outputTokens,
        },
      });
      if (baselineRun.status !== 'completed' || violations.length > 0) evaluationFailed = true;
      else result.summary.completed += 1;
    }
    if (evaluationFailed) result.blocked = { code: 'EVAL_RUN_FAILED', message: safeMessage('EVAL_RUN_FAILED') };
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const code = ['EVAL_CONFIG_UNAVAILABLE', 'EVAL_MODEL_UNAVAILABLE'].includes(raw) ? raw : /credential|provider|configuration/iu.test(raw) ? 'EVAL_PROVIDER_UNAVAILABLE' : 'EVAL_RUN_FAILED';
    result.blocked = { code, message: safeMessage(code) };
  } finally {
    let cleaned = await cleanupEvalResources({ baseline, candidate, harness, credentialVault });
    try { baselineStore?.close(); } catch { cleaned = false; }
    try { candidateStore?.close(); } catch { cleaned = false; }
    if (!cleaned) result.blocked = { code: 'EVAL_RUN_FAILED', message: safeMessage('EVAL_RUN_FAILED') };
    await writeEvalOutput(projectRoot, output, result);
  }
  if (result.blocked) process.exitCode = 2;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'EVAL_RUN_FAILED'}\n`);
  process.exitCode = 2;
});
