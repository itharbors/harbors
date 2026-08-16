import { Fragment, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { ToolProcessEntry, TraceStep, TraceTurn } from "./trace-events.js";

marked.setOptions({ gfm: true, breaks: true });

interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface PermissionRequest {
  requestId: string;
  conversationId: string;
  turn: number;
  step: number;
  toolName: string;
  currentMode: string;
  requestedMode?: string;
  justification?: string;
}

type PermissionOutcome = "allowed-once" | "rejected";

interface TranscriptProps {
  draft: boolean;
  project: string | null;
  modelLabel: string;
  messages: MessageData[];
  traceTurns: TraceTurn[];
  localProcessEntries: ToolProcessEntry[];
  turnOffset: number;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  activity: string | null;
  sending: boolean;
}

function MarkdownMessage({ content }: { content: string }) {
  const html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function parseJson(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolNameFromPartType(type: string): string {
  if (type.startsWith("tool-")) {
    return type.slice("tool-".length);
  }
  return type;
}

interface ToolPart {
  type: string;
  toolCallId: string;
  state: "input-available" | "output-available" | "output-error";
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function toolEntryToPart(entry: ToolProcessEntry): ToolPart {
  const input = parseJson(entry.arguments);
  if (entry.isError) {
    return {
      type: `tool-${entry.name}`,
      toolCallId: entry.callId,
      state: "output-error",
      input,
      errorText: entry.result || "工具执行失败",
    };
  }
  if (entry.result !== undefined) {
    return {
      type: `tool-${entry.name}`,
      toolCallId: entry.callId,
      state: "output-available",
      input,
      output: parseJson(entry.result),
    };
  }
  return {
    type: `tool-${entry.name}`,
    toolCallId: entry.callId,
    state: "input-available",
    input,
  };
}

function ToolPartView({ part }: { part: ToolPart }) {
  const toolName = getToolNameFromPartType(part.type);
  const isError = part.state === "output-error";
  const isDone = part.state === "output-available";
  const statusLabel = isError ? "已失败" : isDone ? "已完成" : "处理中";
  const statusClass = isError ? "error" : isDone ? "success" : "pending";

  return (
    <details className={`agent-tool ${isError ? "error" : ""}`}>
      <summary>
        <span className={`tool-status ${statusClass}`}>{statusLabel}</span>
        <span className="tool-name">{toolName}</span>
      </summary>
      {part.input !== undefined && part.input !== null && (
        <div className="tool-arguments">
          <div className="tool-section-title">参数</div>
          <pre><code>{stringifyValue(part.input)}</code></pre>
        </div>
      )}
      {part.state === "output-available" && part.output !== undefined && (
        <div className="tool-result">
          <div className="tool-section-title">结果</div>
          <pre><code>{stringifyValue(part.output)}</code></pre>
        </div>
      )}
      {part.state === "output-error" && (
        <div className="tool-result error">
          <div className="tool-section-title">错误</div>
          <pre><code>{part.errorText}</code></pre>
        </div>
      )}
      {part.state === "input-available" && (
        <div className="tool-result">
          <span className="tool-result-pending">处理中…</span>
        </div>
      )}
    </details>
  );
}

function PermissionRequestCard({
  request,
  resolving,
  onResolve,
}: {
  request: PermissionRequest;
  resolving: boolean;
  onResolve: (outcome: PermissionOutcome) => void;
}) {
  const modeLabel = (mode?: string): string =>
    ({
      "read-only": "只读",
      "workspace-write": "工作区可写",
      "danger-full-access": "完全访问",
    }[mode || ""] || mode || "未说明");

  return (
    <div className="permission-card">
      <div className="permission-card-header">
        <span className="permission-title">需要权限确认</span>
        <span className="permission-status">等待处理</span>
      </div>
      <div className="permission-card-tool">
        工具：<strong>{request.toolName}</strong>
      </div>
      <div className="permission-card-modes">
        当前：{modeLabel(request.currentMode)} → 请求：{modeLabel(request.requestedMode)}
      </div>
      {request.justification && <p className="permission-card-justification">{request.justification}</p>}
      <div className="permission-card-actions">
        <button type="button" onClick={() => onResolve("rejected")} disabled={resolving}>
          拒绝
        </button>
        <button
          type="button"
          className="approve"
          onClick={() => onResolve("allowed-once")}
          disabled={resolving}
        >
          允许一次
        </button>
      </div>
    </div>
  );
}

interface DisplayStep extends TraceStep {
  localRequest?: ToolProcessEntry;
}

interface DisplayTurn {
  turn: number;
  steps: DisplayStep[];
  error?: ToolProcessEntry;
}

function assistantTextsAfter(messages: MessageData[], userIndex: number): { texts: string[]; nextIndex: number } {
  const texts: string[] = [];
  let nextIndex = userIndex + 1;
  while (nextIndex < messages.length && messages[nextIndex].role === "assistant") {
    if (messages[nextIndex].content) texts.push(messages[nextIndex].content);
    nextIndex += 1;
  }
  return { texts, nextIndex };
}

function buildDisplayTurns(messages: MessageData[], traceTurns: TraceTurn[], localProcessEntries: ToolProcessEntry[], turnOffset: number): Array<{ user: MessageData; turn: DisplayTurn }> {
  const result: Array<{ user: MessageData; turn: DisplayTurn }> = [];
  let turnNumber = turnOffset;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    turnNumber += 1;
    const assistant = assistantTextsAfter(messages, index);
    const sourceTurn = traceTurns.find((item) => item.turn === turnNumber);
    const steps: DisplayStep[] = (sourceTurn?.steps || []).map((step) => ({ ...step, tools: [...step.tools] }));
    const localRequests = localProcessEntries.filter((entry) => entry.turn === turnNumber && entry.name === "请求模型");
    for (const localRequest of localRequests) {
      let step = steps.find((item) => item.step === localRequest.step);
      if (!step) {
        step = { turn: turnNumber, step: localRequest.step || 1, tools: [], completed: false };
        steps.push(step);
      }
      step.localRequest = localRequest;
    }

    if (assistant.texts.length > 0 && !steps.some((step) => step.assistant && !step.assistant.hasToolCalls)) {
      const step = steps.at(-1) || { turn: turnNumber, step: 1, tools: [], completed: false };
      if (!steps.includes(step)) steps.push(step);
      step.assistant = { id: `live-assistant-${message.id}`, seq: Number.MAX_SAFE_INTEGER, turn: turnNumber, step: step.step, text: assistant.texts.at(-1) || "", hasToolCalls: false };
    }
    if (sourceTurn?.error && steps.length === 0) steps.push({ turn: turnNumber, step: 1, tools: [], completed: false });
    steps.sort((left, right) => left.step - right.step);
    result.push({ user: message, turn: { turn: turnNumber, steps, error: sourceTurn?.error } });
    index = assistant.nextIndex - 1;
  }
  return result;
}

function AssistantStep({
  step,
  turn,
  turnError,
  modelLabel,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  activity,
  sending,
}: {
  step: DisplayStep;
  turn: number;
  turnError?: ToolProcessEntry;
  modelLabel: string;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  activity: string | null;
  sending: boolean;
}) {
  const request = step.localRequest;
  const thinkingText = step.assistant?.hasToolCalls ? step.assistant.text : "";
  const finalText = step.assistant && !step.assistant.hasToolCalls ? step.assistant.text : "";
  const hasRunningTool = step.tools.some((part) => part.result === undefined && !part.isError);
  let statusLabel = "处理中";
  let statusClass: "pending" | "done" | "error" = "pending";
  if (request?.isError || step.tools.some((part) => part.isError) || turnError) {
    statusLabel = "执行出错";
    statusClass = "error";
  } else if (hasRunningTool || (request && request.result === undefined && !step.assistant)) {
    statusLabel = "处理中";
  } else if (step.assistant || step.completed || request?.result !== undefined) {
    statusLabel = "已完成";
    statusClass = "done";
  }

  return (
    <div className="agent-step">
      <div className="agent-step-header">
        <span className="agent-step-number">Step {turn}.{step.step}</span>
        <span className={`agent-step-label ${statusClass}`}>{statusLabel}</span>
        <span className="agent-step-model">{step.model || modelLabel}</span>
      </div>

      {(step.requestSeq !== undefined || request) && (
        <details className="agent-step-request">
          <summary>请求上下文</summary>
          <div className="agent-step-request-body">模型：{step.model || modelLabel}</div>
        </details>
      )}

      {request?.isError && request.result && <div className="agent-step-error">{request.result}</div>}

      {thinkingText && (
        <div className="agent-step-intent">
          <div className="agent-step-intent-label">模型下一步</div>
          <div className="chat-message assistant"><div className="chat-message-content"><MarkdownMessage content={thinkingText} /></div></div>
        </div>
      )}

      {step.tools.length > 0 && (
        <div className="agent-step-tools">
          <div className="agent-step-tools-title">工具调用</div>
          {step.tools.map((part) => <div key={part.callId || part.id}><ToolPartView part={toolEntryToPart(part)} /></div>)}
        </div>
      )}

      {finalText && (
        <div className="agent-step-intent">
          <div className="agent-step-intent-label">最终回复</div>
          <div className="chat-message assistant"><div className="chat-message-content"><MarkdownMessage content={finalText} /></div></div>
        </div>
      )}

      {permissionRequests.filter((requestItem) => requestItem.turn === turn && requestItem.step === step.step).map((requestItem) => (
        <div key={requestItem.requestId}><PermissionRequestCard request={requestItem} resolving={resolvingPermissionId === requestItem.requestId} onResolve={(outcome) => void onResolvePermission(requestItem.requestId, outcome)} /></div>
      ))}

      {sending && !thinkingText && !finalText && step.tools.length === 0 && !request?.isError && <div className="sending-indicator">{activity || "正在生成回复…"}</div>}
      {turnError && <div className="agent-step-error">{turnError.result}</div>}
    </div>
  );
}

export default function Transcript(props: TranscriptProps) {
  const { draft, project, modelLabel, messages, traceTurns, localProcessEntries, turnOffset, permissionRequests, resolvingPermissionId, onResolvePermission, activity, sending } = props;
  const displayTurns = useMemo(() => buildDisplayTurns(messages, traceTurns, localProcessEntries, turnOffset), [messages, traceTurns, localProcessEntries, turnOffset]);

  return (
    <div className={`chat-surface ${draft || messages.length === 0 ? "fresh" : ""}`}>
      {(draft || messages.length === 0) && (
        <div className="new-thread-context">
          <span>▣ 当前项目</span>
          <strong>{project ? project.split("/").filter(Boolean).slice(-2).join(" / ") : "本地项目"}</strong>
          <span>⚓ HubBert · {modelLabel}</span>
        </div>
      )}

      {displayTurns.map(({ user, turn }) => (
        <Fragment key={user.id}>
          <div className="chat-message user"><div className="chat-message-content"><MarkdownMessage content={user.content} /></div></div>
          {turn.steps.map((step) => <Fragment key={`${turn.turn}-${step.step}`}><AssistantStep step={step} turn={turn.turn} turnError={turn.error && step === turn.steps.at(-1) ? turn.error : undefined} modelLabel={modelLabel} permissionRequests={permissionRequests} resolvingPermissionId={resolvingPermissionId} onResolvePermission={onResolvePermission} activity={activity} sending={sending} /></Fragment>)}
        </Fragment>
      ))}

      {sending && displayTurns.every(({ turn }) => turn.steps.length === 0) && <div className="sending-indicator">{activity || "正在生成回复…"}</div>}
    </div>
  );
}
