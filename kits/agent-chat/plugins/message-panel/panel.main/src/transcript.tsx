import { Fragment, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { UIMessage } from "@ai-sdk/react";
import type { ToolProcessEntry } from "./trace-events.js";

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
  processEntries: ToolProcessEntry[];
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

function buildUIMessages(messages: MessageData[], processEntries: ToolProcessEntry[], turnOffset: number): UIMessage[] {
  const entriesByTurn = new Map<number, ToolProcessEntry[]>();
  for (const entry of processEntries) {
    const list = entriesByTurn.get(entry.turn) ?? [];
    list.push(entry);
    entriesByTurn.set(entry.turn, list);
  }

  const uiMessages: UIMessage[] = [];
  let currentTurn = turnOffset;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    currentTurn += 1;
    uiMessages.push({
      id: msg.id,
      role: "user",
      parts: [{ type: "text", text: msg.content }],
    });

    const assistantTexts: string[] = [];
    let nextIndex = i + 1;
    while (nextIndex < messages.length && messages[nextIndex].role === "assistant") {
      if (messages[nextIndex].content) assistantTexts.push(messages[nextIndex].content);
      nextIndex += 1;
    }
    const turnEntries = entriesByTurn.get(currentTurn) ?? [];
    const hasAssistant = assistantTexts.length > 0;

    if (hasAssistant || turnEntries.length > 0) {
      const parts: Array<{ type: "text"; text: string } | ToolPart> = [];
      if (hasAssistant) parts.push({ type: "text", text: assistantTexts.join("\n\n") });
      parts.push(...turnEntries.map(toolEntryToPart));
      uiMessages.push({
        id: hasAssistant ? messages[i + 1].id : `assistant-turn-${currentTurn}`,
        role: "assistant",
        parts: parts as unknown as UIMessage["parts"],
      });
    }

    i = nextIndex - 1;
  }

  return uiMessages;
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

function AssistantStep({
  message,
  turn,
  modelLabel,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  activity,
  sending,
}: {
  message: UIMessage;
  turn: number;
  modelLabel: string;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  activity: string | null;
  sending: boolean;
}) {
  const textParts = message.parts.filter((p) => p.type === "text") as Array<{ type: "text"; text: string }>;
  const toolParts = message.parts.filter((p) => p.type.startsWith("tool-")) as unknown as ToolPart[];
  const requestPart = toolParts.find((part) => getToolNameFromPartType(part.type) === "请求模型");
  const processParts = toolParts.filter((part) => part !== requestPart);
  const assistantText = textParts.map((p) => p.text).join("");
  const requestFailed = requestPart?.state === "output-error";
  const requestDone = requestPart?.state === "output-available";

  return (
    <div className="agent-step">
      <div className="agent-step-header">
        <span className="agent-step-number">Step {turn}</span>
        <span className={`agent-step-label ${requestFailed ? "error" : requestDone ? "done" : "pending"}`}>
          {requestFailed ? "请求失败" : requestDone ? "请求模型完成" : "请求模型"}
        </span>
        <span className="agent-step-model">{modelLabel}</span>
      </div>

      {assistantText && (
        <div className="agent-step-intent">
          <div className="agent-step-intent-label">模型下一步</div>
          <div className="chat-message assistant">
            <div className="chat-message-content">
              <MarkdownMessage content={assistantText} />
            </div>
          </div>
        </div>
      )}

      {requestFailed && requestPart?.errorText && (
        <div className="agent-step-error">{requestPart.errorText}</div>
      )}

      {processParts.length > 0 && (
        <div className="agent-step-tools">
          <div className="agent-step-tools-title">工具调用</div>
          {processParts.map((part) => (
            <div key={part.toolCallId || part.type}>
              <ToolPartView part={part} />
            </div>
          ))}
        </div>
      )}

      {permissionRequests.filter((request) => request.turn === turn).map((request) => (
        <div key={request.requestId}>
          <PermissionRequestCard
            request={request}
            resolving={resolvingPermissionId === request.requestId}
            onResolve={(outcome) => void onResolvePermission(request.requestId, outcome)}
          />
        </div>
      ))}

      {sending && !assistantText && processParts.length === 0 && !requestPart && (
        <div className="sending-indicator">{activity || "正在生成回复…"}</div>
      )}
    </div>
  );
}

export default function Transcript(props: TranscriptProps) {
  const { draft, project, modelLabel, messages, processEntries, turnOffset, permissionRequests, resolvingPermissionId, onResolvePermission, activity, sending } = props;

  const uiMessages = useMemo(
    () => buildUIMessages(messages, processEntries, turnOffset),
    [messages, processEntries, turnOffset],
  );

  return (
    <div className={`chat-surface ${draft || messages.length === 0 ? "fresh" : ""}`}>
      {(draft || messages.length === 0) && (
        <div className="new-thread-context">
          <span>▣ 当前项目</span>
          <strong>{project ? project.split("/").filter(Boolean).slice(-2).join(" / ") : "本地项目"}</strong>
          <span>⚓ HubBert · {modelLabel}</span>
        </div>
      )}

      {uiMessages.map((msg) => {
        if (msg.role === "user") {
          const textPart = msg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
          return (
            <div key={msg.id} className="chat-message user">
              <div className="chat-message-content">
                <MarkdownMessage content={textPart?.text || ""} />
              </div>
            </div>
          );
        }

        const turn = turnOffset + uiMessages
          .slice(0, uiMessages.indexOf(msg) + 1)
          .filter((item) => item.role === "user").length;
        return (
          <Fragment key={msg.id}>
            <AssistantStep
              message={msg}
              turn={turn}
              modelLabel={modelLabel}
              permissionRequests={permissionRequests}
              resolvingPermissionId={resolvingPermissionId}
              onResolvePermission={onResolvePermission}
              activity={activity}
              sending={sending}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
