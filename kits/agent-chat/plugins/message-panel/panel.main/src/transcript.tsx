import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import type { ToolProcessEntry, TraceStep, TraceTurn } from "./trace-events.js";

marked.setOptions({ gfm: true, breaks: true });

export interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  turn?: number;
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
  sending: boolean;
  conversationActive: boolean;
  onChangeProject?: () => void;
  onLinkClick?: (info: { href: string; text: string }) => void;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function markdownRenderer(): Renderer {
  const renderer = new Renderer();
  renderer.link = function ({ href, title, tokens }) {
    const escapedHref = escapeHtmlAttribute(href);
    const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    // 始终保留锚点的可点击语义，但绝不把未经消费者确认的目标交给浏览器导航。
    return `<a href="#" data-original-href="${escapedHref}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
  };
  return renderer;
}

type HtmlSanitizer = (dirty: string, config: { ADD_ATTR: string[] }) => string;

export function renderMarkdownHtml(
  content: string,
  sanitize: HtmlSanitizer = (dirty, config) => String(DOMPurify.sanitize(dirty, config)),
): string {
  const rendered = marked.parse(content, { async: false, renderer: markdownRenderer() }) as string;
  // 原始目标仅作为数据保留；真实 href 是不可外跳的安全占位，HTML 结构仍由 DOMPurify 清理。
  return sanitize(rendered, { ADD_ATTR: ["data-original-href"] });
}

export function originalLinkTarget(anchor: Pick<Element, "getAttribute">): string {
  return anchor.getAttribute("data-original-href") || anchor.getAttribute("href") || "";
}

interface MarkdownLinkEvent {
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function anchorFromEvent(event: Pick<MarkdownLinkEvent, "target"> & { composedPath?: () => EventTarget[] }): HTMLAnchorElement | null {
  for (const item of event.composedPath?.() || []) {
    if (item instanceof Element && item.matches("a")) return item as HTMLAnchorElement;
  }
  return (event.target as HTMLElement | null)?.closest?.("a") || null;
}

export function handleMarkdownLinkActivation(
  event: MarkdownLinkEvent,
  onLinkClick?: (info: { href: string; text: string }) => void,
): boolean {
  const anchor = anchorFromEvent(event);
  if (!anchor) return false;
  event.preventDefault();
  event.stopPropagation();
  const href = originalLinkTarget(anchor);
  if (!href) return false;
  onLinkClick?.({ href, text: anchor.textContent || "" });
  return true;
}

const POINTER_DRAG_THRESHOLD = 8;
const SYNTHETIC_CLICK_WINDOW_MS = 1_000;

export function createMarkdownLinkActivationController(
  onLinkClick?: (info: { href: string; text: string }) => void,
  now: () => number = Date.now,
) {
  let pointer: { id: number; anchor: HTMLAnchorElement; x: number; y: number; moved: boolean } | null = null;
  let suppressedClick: { anchor: HTMLAnchorElement; expiresAt: number } | null = null;

  const isMainPointer = (event: PointerEvent) => event.isPrimary !== false && event.button === 0;
  const movedBeyondThreshold = (event: PointerEvent) => pointer !== null
    && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > POINTER_DRAG_THRESHOLD;

  return {
    pointerDown(event: PointerEvent) {
      const anchor = anchorFromEvent(event);
      pointer = anchor && isMainPointer(event)
        ? { id: event.pointerId, anchor, x: event.clientX, y: event.clientY, moved: false }
        : null;
    },
    pointerMove(event: PointerEvent) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (movedBeyondThreshold(event)) pointer.moved = true;
    },
    pointerUp(event: PointerEvent) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const current = pointer;
      pointer = null;
      const anchor = anchorFromEvent(event);
      const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > POINTER_DRAG_THRESHOLD;
      if (!isMainPointer(event) || anchor !== current.anchor || moved) {
        // 某些浏览器在拖动结束后仍会合成 click；只抑制该 click，不广播。
        if (anchor === current.anchor) suppressedClick = { anchor, expiresAt: now() + SYNTHETIC_CLICK_WINDOW_MS };
        return;
      }
      suppressedClick = { anchor, expiresAt: now() + SYNTHETIC_CLICK_WINDOW_MS };
      handleMarkdownLinkActivation(event, onLinkClick);
    },
    pointerCancel(event: PointerEvent) {
      if (pointer?.id === event.pointerId) pointer = null;
    },
    click(event: MouseEvent) {
      const anchor = anchorFromEvent(event);
      if (!anchor || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.detail > 0 && suppressedClick?.anchor === anchor && suppressedClick.expiresAt >= now()) {
        suppressedClick = null;
        return;
      }
      suppressedClick = null;
      const href = originalLinkTarget(anchor);
      if (href) onLinkClick?.({ href, text: anchor.textContent || "" });
    },
  };
}

function MarkdownMessage({ content }: { content: string }) {
  const html = renderMarkdownHtml(content);
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

export interface DisplayTurn {
  turn: number;
  steps: DisplayStep[];
  error?: ToolProcessEntry;
  terminal?: TraceTurn["terminal"];
  trailingIncompleteStep?: TraceTurn["trailingIncompleteStep"];
  hasStructuredTrace: boolean;
  status: "running" | "interrupted" | "completed" | "failed";
}

export function shouldCollapseTurn(turn: DisplayTurn): boolean {
  return turn.status === "completed" && turn.steps.some((step) => step.assistant && !step.assistant.hasToolCalls);
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

export function buildDisplayTurns(
  messages: MessageData[],
  traceTurns: TraceTurn[],
  localProcessEntries: ToolProcessEntry[],
  turnOffset: number,
  conversationActive = false,
): Array<{ user: MessageData; turn: DisplayTurn }> {
  const result: Array<{ user: MessageData; turn: DisplayTurn }> = [];
  let turnNumber = turnOffset;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const messageTurn = Number(message.turn);
    turnNumber = Number.isSafeInteger(messageTurn) && messageTurn > 0 ? messageTurn : turnNumber + 1;
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

    // 结构化 trace 存在时只信任其中的 assistant/turn 终态；surface fallback 仅兼容完全无 trace 的旧会话。
    if (!sourceTurn && assistant.texts.length > 0) {
      const step = steps.at(-1) || { turn: turnNumber, step: 1, tools: [], completed: false };
      if (!steps.includes(step)) steps.push(step);
      step.assistant = { id: `live-assistant-${message.id}`, seq: Number.MAX_SAFE_INTEGER, turn: turnNumber, step: step.step, text: assistant.texts.at(-1) || "", hasToolCalls: false };
    }
    if (sourceTurn?.error && steps.length === 0) steps.push({ turn: turnNumber, step: 1, tools: [], completed: false });
    steps.sort((left, right) => left.step - right.step);
    const hasLegacyFinal = !sourceTurn && assistant.texts.length > 0;
    const status: DisplayTurn["status"] = sourceTurn?.terminal?.status === "failed"
      ? "failed"
      : sourceTurn?.terminal?.status === "completed" || hasLegacyFinal
        ? "completed"
        : "interrupted";
    result.push({
      user: message,
      turn: {
        turn: turnNumber,
        steps,
        error: sourceTurn?.error,
        terminal: sourceTurn?.terminal,
        trailingIncompleteStep: sourceTurn?.trailingIncompleteStep,
        hasStructuredTrace: Boolean(sourceTurn),
        status,
      },
    });
    index = assistant.nextIndex - 1;
  }
  const latestIncomplete = [...result].reverse().find((item) => item.turn.status === "interrupted");
  if (conversationActive && latestIncomplete) latestIncomplete.turn.status = "running";
  return result;
}

export function nextDisplayTurn(messages: MessageData[], traceTurns: TraceTurn[]): number {
  const latestKnownTurn = Math.max(0, ...messages.map((message) => message.turn || 0), ...traceTurns.map((turn) => turn.turn));
  return latestKnownTurn > 0 ? latestKnownTurn + 1 : messages.filter((message) => message.role === "user").length + 1;
}

function AssistantStep({
  step,
  turn,
  turnError,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  sending,
  collapsed,
  turnStatus,
}: {
  step: DisplayStep;
  turn: number;
  turnError?: ToolProcessEntry;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  sending: boolean;
  collapsed: boolean;
  turnStatus: DisplayTurn["status"];
}) {
  const request = step.localRequest;
  const isFinalResponse = turnStatus === "completed" && step.assistant && !step.assistant.hasToolCalls;
  const thinkingText = [step.assistant?.thinking, step.assistant && !isFinalResponse ? step.assistant.text : ""].filter(Boolean).join("\n\n");
  const finalText = isFinalResponse ? step.assistant?.text || "" : "";
  const stepPermissions = permissionRequests.filter((requestItem) => requestItem.turn === turn && requestItem.step === step.step);

  // 折叠时只保留最终回复，隐藏过程信息（错误、思考、工具）
  const hideProcess = collapsed;

  // 折叠且该 step 既无最终回复也无待处理权限请求时，不渲染以避免空白间距
  if (hideProcess && !finalText && stepPermissions.length === 0) return null;

  return (
    <div className="agent-cycle">
      {!hideProcess && request?.isError && request.result && <div className="agent-step-error">{request.result}</div>}

      {!hideProcess && thinkingText && (
        <div className="agent-step-intent">
          <div className="chat-message assistant"><div className="chat-message-content"><MarkdownMessage content={thinkingText} /></div></div>
        </div>
      )}

      {!hideProcess && step.tools.length > 0 && (
        <div className="agent-step-tools">
          {step.tools.map((part) => <div key={part.callId || part.id}><ToolPartView part={toolEntryToPart(part)} /></div>)}
        </div>
      )}

      {finalText && (
        <div className="agent-step-intent agent-final-response">
          <div className="chat-message assistant">
            <div className="chat-message-label assistant-label">Agent</div>
            <div className="chat-message-content"><MarkdownMessage content={finalText} /></div>
          </div>
        </div>
      )}

      {stepPermissions.map((requestItem) => (
        <div key={requestItem.requestId}><PermissionRequestCard request={requestItem} resolving={resolvingPermissionId === requestItem.requestId} onResolve={(outcome) => void onResolvePermission(requestItem.requestId, outcome)} /></div>
      ))}

      {!hideProcess && turnError && <div className="agent-step-error">{turnError.result}</div>}
    </div>
  );
}

function TurnBlock({
  turn,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  sending,
}: {
  turn: DisplayTurn;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  sending: boolean;
}) {
  // 只有明确完成且存在真实最终回复时默认折叠；运行、中断和失败都默认展开过程。
  const hasFinalResponse = shouldCollapseTurn(turn);
  // 用户手动设置的折叠状态；null 表示跟随默认策略
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  // 默认策略：完成且有最终回复才折叠。
  const collapsed = manualCollapsed ?? hasFinalResponse;

  const statusLabel = ({ running: "运行中", interrupted: "已中断", completed: "已完成", failed: "失败" } as const)[turn.status];
  const phaseLabel = turn.trailingIncompleteStep
    ? ({ step_started: "步骤启动阶段", model_request: "模型请求阶段", model_response: "模型响应阶段", tool_execution: "工具执行阶段" } as const)[turn.trailingIncompleteStep.phase]
    : null;

  const toggle = () => setManualCollapsed(!collapsed);

  return (
    <div className={`agent-step ${collapsed ? "collapsed" : ""}`}>
      <button type="button" className="agent-turn-header" onClick={toggle} aria-expanded={!collapsed}>
        <span className="agent-turn-caret">›</span>
        <span className="agent-turn-title">Turn {turn.turn}</span>
        <span className={`agent-turn-status ${turn.status}`}>{statusLabel}</span>
        <span className="agent-turn-hint">{collapsed ? "展开过程" : "收起过程"}</span>
      </button>
      {turn.steps.map((step) => (
        <Fragment key={`${turn.turn}-${step.step}`}>
          <AssistantStep
            step={step}
            turn={turn.turn}
            turnError={turn.error && step === turn.steps.at(-1) ? turn.error : undefined}
            permissionRequests={permissionRequests}
            resolvingPermissionId={resolvingPermissionId}
            onResolvePermission={onResolvePermission}
            sending={sending}
            collapsed={collapsed}
            turnStatus={turn.status}
          />
        </Fragment>
      ))}
      {!collapsed && turn.status === "interrupted" && turn.trailingIncompleteStep && (
        <div className="agent-turn-interrupted">Turn {turn.turn} 在 Step {turn.trailingIncompleteStep.step} 的{phaseLabel}中断，未收到 turn/end。</div>
      )}
    </div>
  );
}

export default function Transcript(props: TranscriptProps) {
  const { draft, project, modelLabel, messages, traceTurns, localProcessEntries, turnOffset, permissionRequests, resolvingPermissionId, onResolvePermission, sending, conversationActive, onChangeProject, onLinkClick } = props;
  const displayTurns = useMemo(() => buildDisplayTurns(messages, traceTurns, localProcessEntries, turnOffset, conversationActive || sending), [messages, traceTurns, localProcessEntries, turnOffset, conversationActive, sending]);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const controller = createMarkdownLinkActivationController(onLinkClick);
    surface.addEventListener("pointerdown", controller.pointerDown, true);
    surface.addEventListener("pointermove", controller.pointerMove, true);
    surface.addEventListener("pointerup", controller.pointerUp, true);
    surface.addEventListener("pointercancel", controller.pointerCancel, true);
    surface.addEventListener("click", controller.click, true);
    return () => {
      surface.removeEventListener("pointerdown", controller.pointerDown, true);
      surface.removeEventListener("pointermove", controller.pointerMove, true);
      surface.removeEventListener("pointerup", controller.pointerUp, true);
      surface.removeEventListener("pointercancel", controller.pointerCancel, true);
      surface.removeEventListener("click", controller.click, true);
    };
  }, [onLinkClick]);

  return (
    <div ref={surfaceRef} className={`chat-surface ${draft ? "fresh" : ""}`}>
      {draft && (
        <div className="new-thread-context">
          <span>▣ 当前项目</span>
          <strong title={project || undefined}>{project ? project.split("/").filter(Boolean).slice(-2).join(" / ") : "本地项目"}</strong>
          {onChangeProject && <button type="button" className="new-thread-change-project" onClick={onChangeProject}>更换目录</button>}
          <span>⚓ HubBert · {modelLabel}</span>
        </div>
      )}

      {displayTurns.map(({ user, turn }) => (
        <Fragment key={user.id}>
          <div className="chat-message user">
            <div className="chat-message-content"><MarkdownMessage content={user.content} /></div>
          </div>
          {(turn.hasStructuredTrace || turn.steps.length > 0) && (
            <TurnBlock
              turn={turn}
              permissionRequests={permissionRequests}
              resolvingPermissionId={resolvingPermissionId}
              onResolvePermission={onResolvePermission}
              sending={sending}
            />
          )}
        </Fragment>
      ))}

    </div>
  );
}
