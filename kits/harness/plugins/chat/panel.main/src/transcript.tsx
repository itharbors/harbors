import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
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
  turnId?: string;
  itemId?: string;
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
  messageRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderMarkdownCodeFallback(code: string): string {
  return `<pre><code>${escapeHtmlAttribute(code)}</code></pre>`;
}

export function readMarkdownRendererCode(node: Pick<HTMLDivElement, "querySelector" | "getAttribute">): string {
  const codeElement = node.querySelector("pre > code");
  return codeElement ? codeElement.textContent ?? "" : node.getAttribute("data-code") ?? "";
}

export function renderMarkdownRendererOutput(code: string, rendered: unknown): string {
  return typeof rendered === "string" && rendered.trim().length > 0
    ? rendered
    : renderMarkdownCodeFallback(code);
}

// 已注册的代码块渲染器语言集合
const registeredRendererLanguages = new Set<string>();

function markdownRenderer(rendererLanguages: ReadonlySet<string> = registeredRendererLanguages): Renderer {
  const renderer = new Renderer();
  const defaultCodeRenderer = renderer.code.bind(renderer);
  renderer.link = function ({ href, title, tokens }) {
    const escapedHref = escapeHtmlAttribute(href);
    const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    // 始终保留锚点的可点击语义，但绝不把未经消费者确认的目标交给浏览器导航。
    return `<a href="#" data-original-href="${escapedHref}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
  };
  renderer.code = function (token) {
    const { text, lang } = token;
    // 如果该语言有注册的渲染器，输出占位 div，由 useEffect 异步渲染
    if (lang && rendererLanguages.has(lang)) {
      const encoded = escapeHtmlAttribute(text);
      return `<div class="markdown-code-block-renderer" data-lang="${escapeHtmlAttribute(lang)}" data-code="${encoded}">${renderMarkdownCodeFallback(text)}</div>`;
    }
    // 其他代码块走默认渲染
    return defaultCodeRenderer(token);
  };
  return renderer;
}

type HtmlSanitizer = (dirty: string, config: { ADD_ATTR: string[]; ADD_TAGS?: string[] }) => string;

type MarkdownHtmlRenderer = (content: string) => string;

const MARKDOWN_CACHE_MAX_ENTRIES = 256;

export function renderMarkdownHtml(
  content: string,
  sanitize: HtmlSanitizer = (dirty, config) => String(DOMPurify.sanitize(dirty, config)),
  rendererLanguages: ReadonlySet<string> = registeredRendererLanguages,
): string {
  const rendered = marked.parse(content, { async: false, renderer: markdownRenderer(rendererLanguages) }) as string;
  // 原始目标仅作为数据保留；真实 href 是不可外跳的安全占位，HTML 结构仍由 DOMPurify 清理。
  // 允许 div 和 data-* 属性用于代码块渲染器占位。
  return sanitize(rendered, {
    ADD_ATTR: ["data-original-href", "data-lang", "data-code"],
    ADD_TAGS: ["div"],
  });
}

export function createMarkdownHtmlCache(
  render: MarkdownHtmlRenderer = renderMarkdownHtml,
  maxEntries = MARKDOWN_CACHE_MAX_ENTRIES,
): { get: (content: string) => string; clear: () => void; size: () => number } {
  const entries = new Map<string, string>();
  const capacity = Math.max(1, Math.floor(maxEntries));

  return {
    get(content) {
      if (entries.has(content)) {
        const cached = entries.get(content)!;
        entries.delete(content);
        entries.set(content, cached);
        return cached;
      }

      const rendered = render(content);
      entries.set(content, rendered);
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return rendered;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

const markdownHtmlCache = createMarkdownHtmlCache();

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
    // composedPath() 可能返回来自另一个 DOM realm 的 Element；不要依赖当前
    // iframe 的全局 Element 构造器做 instanceof 判断。
    if (item && typeof (item as Element).matches === "function" && (item as Element).matches("a")) {
      return item as HTMLAnchorElement;
    }
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
      // pointerup 的 button 在浏览器中可能是 -1；主指针资格只在按下时检查。
      if (anchor !== current.anchor || moved) {
        // 某些浏览器在拖动结束后仍会合成 click；只抑制该 click，不广播。
        if (anchor === current.anchor) suppressedClick = { anchor, expiresAt: now() + SYNTHETIC_CLICK_WINDOW_MS };
        return;
      }
      // 普通激活统一由 click 委托处理；pointerup 只负责结束拖拽状态。
    },
    pointerCancel(event: PointerEvent) {
      if (pointer?.id === event.pointerId) pointer = null;
    },
    click(event: MouseEvent) {
      const anchor = anchorFromEvent(event);
      // 某些触摸/自动化实现的 click.button 为 -1；右键的 button=2 仍应忽略。
      if (!anchor || (event.button !== undefined && event.button !== 0 && event.button !== -1)) return;
      event.preventDefault();
      event.stopPropagation();
      if (suppressedClick?.anchor === anchor && suppressedClick.expiresAt >= now()) {
        suppressedClick = null;
        return;
      }
      suppressedClick = null;
      const href = originalLinkTarget(anchor);
      if (href) onLinkClick?.({ href, text: anchor.textContent || "" });
    },
  };
}

export function bindMarkdownLinkActivationDelegation(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  controller: ReturnType<typeof createMarkdownLinkActivationController>,
  isEligible: (event: Event) => boolean = () => true,
): () => void {
  const pointerDown = (event: Event) => {
    if (isEligible(event)) controller.pointerDown(event as PointerEvent);
  };
  // move/up/cancel 必须继续交给控制器，即使指针已经离开消息列表；否则拖拽
  // 状态不会结束，后续点击可能被错误抑制。
  const pointerMove = (event: Event) => controller.pointerMove(event as PointerEvent);
  const pointerUp = (event: Event) => controller.pointerUp(event as PointerEvent);
  const pointerCancel = (event: Event) => controller.pointerCancel(event as PointerEvent);
  const click = (event: Event) => {
    if (isEligible(event)) controller.click(event as MouseEvent);
  };
  target.addEventListener("pointerdown", pointerDown, true);
  target.addEventListener("pointermove", pointerMove, true);
  target.addEventListener("pointerup", pointerUp, true);
  target.addEventListener("pointercancel", pointerCancel, true);
  target.addEventListener("click", click, true);
  return () => {
    target.removeEventListener("pointerdown", pointerDown, true);
    target.removeEventListener("pointermove", pointerMove, true);
    target.removeEventListener("pointerup", pointerUp, true);
    target.removeEventListener("pointercancel", pointerCancel, true);
    target.removeEventListener("click", click, true);
  };
}

export function createMarkdownLinkActivationReactHandlers(
  controller: ReturnType<typeof createMarkdownLinkActivationController>,
) {
  const unwrap = <T extends Event>(event: T | { nativeEvent?: T }): T => {
    if (event && typeof event === "object" && "nativeEvent" in event && event.nativeEvent) {
      return event.nativeEvent;
    }
    return event as T;
  };
  return {
    onPointerDownCapture(event: PointerEvent | { nativeEvent?: PointerEvent }) {
      controller.pointerDown(unwrap(event));
    },
    onPointerMoveCapture(event: PointerEvent | { nativeEvent?: PointerEvent }) {
      controller.pointerMove(unwrap(event));
    },
    onPointerUpCapture(event: PointerEvent | { nativeEvent?: PointerEvent }) {
      controller.pointerUp(unwrap(event));
    },
    onPointerCancelCapture(event: PointerEvent | { nativeEvent?: PointerEvent }) {
      controller.pointerCancel(unwrap(event));
    },
    onClickCapture(event: MouseEvent | { nativeEvent?: MouseEvent }) {
      controller.click(unwrap(event));
    },
  };
}

// 已加载的渲染器模块缓存
const loadedRendererModules = new Map<string, { load?: () => void | Promise<void>; unload?: () => void | Promise<void>; execute: (code: string) => string | Promise<string> }>();
// 渲染器信息缓存：language -> { plugin, entry }
const rendererInfoByLanguage = new Map<string, { plugin: string; entry: string }>();
let renderersFetchPromise: Promise<void> | null = null;

async function fetchRenderers(messageRequest: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>): Promise<void> {
  if (renderersFetchPromise) return renderersFetchPromise;
  renderersFetchPromise = (async () => {
    try {
      const result = await messageRequest('chat', 'getMarkdownRenderers');
      if (Array.isArray(result)) {
        for (const renderer of result) {
          const { plugin, languages, entry } = renderer as { plugin: string; languages: string[]; entry: string };
          for (const lang of languages) {
            rendererInfoByLanguage.set(lang, { plugin, entry });
            registeredRendererLanguages.add(lang);
          }
        }
      }
    } catch {
      // ignore
    }
  })();
  return renderersFetchPromise;
}

async function loadRendererModule(language: string): Promise<{ execute: (code: string) => string | Promise<string> } | null> {
  const info = rendererInfoByLanguage.get(language);
  if (!info) return null;

  const cached = loadedRendererModules.get(info.plugin);
  if (cached) return cached;

  try {
    const entry = info.entry.replace(/^\.\//, '');
    const url = `/api/assets/plugin/${encodeURIComponent(info.plugin)}/${encodeURIComponent(entry)}`;
    const mod = await import(/* @vite-ignore */ url);
    loadedRendererModules.set(info.plugin, mod);
    if (mod.load) await mod.load();
    return mod;
  } catch (err) {
    console.error(`[markdown-renderer] failed to load renderer for ${language}:`, err);
    return null;
  }
}

const MarkdownMessage = memo(function MarkdownMessage({ content, messageRequest }: { content: string; messageRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(() => markdownHtmlCache.get(content));

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 先获取渲染器列表，填充 registeredRendererLanguages
      if (messageRequest) {
        await fetchRenderers(messageRequest);
      }

      if (cancelled) return;

      // 检查 content 中是否包含已注册语言的代码块
      const hasRegisteredLanguage = Array.from(registeredRendererLanguages).some((lang) =>
        content.includes(`\`\`\`${lang}`),
      );

      // 如果有已注册语言的代码块，需要重新渲染 markdown
      // （因为第一次渲染时这些语言可能还没注册，走了默认代码块）
      if (hasRegisteredLanguage) {
        markdownHtmlCache.clear();
        const newHtml = markdownHtmlCache.get(content);
        setHtml(newHtml);

        // 等待 DOM 更新后再处理占位 div
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled) return;
      }

      const container = containerRef.current;
      if (!container) return;

      const placeholderNodes = container.querySelectorAll<HTMLDivElement>('.markdown-code-block-renderer');
      if (placeholderNodes.length === 0) return;

      for (const node of placeholderNodes) {
        if (cancelled) return;
        const lang = node.getAttribute('data-lang') || '';
        const code = readMarkdownRendererCode(node);

        const mod = await loadRendererModule(lang);
        if (!mod) {
          // 渲染器不可用，降级为普通代码块
          node.outerHTML = renderMarkdownCodeFallback(code);
          continue;
        }

        try {
          const rendered = await mod.execute(code);
          node.outerHTML = renderMarkdownRendererOutput(code, rendered);
        } catch (err) {
          console.error(`[markdown-renderer] failed to execute renderer for ${lang}:`, err);
          node.outerHTML = renderMarkdownCodeFallback(code);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [content, messageRequest]);

  return <div ref={containerRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
});

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

const ToolPartView = memo(function ToolPartView({ entry }: { entry: ToolProcessEntry }) {
  const part = useMemo(() => toolEntryToPart(entry), [entry]);
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
});

const PermissionRequestCard = memo(function PermissionRequestCard({
  request,
  resolving,
  onResolvePermission,
}: {
  request: PermissionRequest;
  resolving: boolean;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
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
        <button type="button" onClick={() => void onResolvePermission(request.requestId, "rejected")} disabled={resolving}>
          拒绝
        </button>
        <button
          type="button"
          className="approve"
          onClick={() => void onResolvePermission(request.requestId, "allowed-once")}
          disabled={resolving}
        >
          允许一次
        </button>
      </div>
    </div>
  );
});

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
  status: "running" | "interrupted" | "completed" | "failed" | "cancelled" | "rejected" | "timed_out";
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

export type DisplayTurnRow = { user: MessageData; turn: DisplayTurn };

function displayTurnRowKey(turn: number, user: MessageData): string {
  return `${turn}\u0000${user.id}`;
}

export interface DisplayTurnProjector {
  project: (
    messages: MessageData[],
    traceTurns: TraceTurn[],
    localProcessEntries: ToolProcessEntry[],
    turnOffset: number,
    conversationActive?: boolean,
  ) => DisplayTurnRow[];
}

function sameMessage(left: MessageData, right: MessageData): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.content === right.content
    && left.turn === right.turn;
}

function sameToolEntry(left: ToolProcessEntry | undefined, right: ToolProcessEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id
    && left.seq === right.seq
    && left.turn === right.turn
    && left.step === right.step
    && left.callId === right.callId
    && left.name === right.name
    && left.arguments === right.arguments
    && left.result === right.result
    && left.isError === right.isError;
}

function sameAssistant(
  left: TraceStep["assistant"] | undefined,
  right: TraceStep["assistant"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id
    && left.seq === right.seq
    && left.turn === right.turn
    && left.step === right.step
    && left.text === right.text
    && left.thinking === right.thinking
    && left.hasToolCalls === right.hasToolCalls;
}

function sameTraceStep(left: TraceStep | undefined, right: TraceStep | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.turn !== right.turn
    || left.step !== right.step
    || left.startSeq !== right.startSeq
    || left.requestSeq !== right.requestSeq
    || left.model !== right.model
    || left.completed !== right.completed
    || !sameAssistant(left.assistant, right.assistant)
    || left.tools.length !== right.tools.length) return false;
  for (let index = 0; index < left.tools.length; index += 1) {
    if (!sameToolEntry(left.tools[index], right.tools[index])) return false;
  }
  return true;
}

function sameIncomplete(
  left: TraceTurn["trailingIncompleteStep"] | undefined,
  right: TraceTurn["trailingIncompleteStep"] | undefined,
): boolean {
  return left?.step === right?.step && left?.phase === right?.phase;
}

function sameTerminal(
  left: TraceTurn["terminal"] | undefined,
  right: TraceTurn["terminal"] | undefined,
): boolean {
  return left?.status === right?.status && left?.seq === right?.seq && left?.reason === right?.reason;
}

function sameDisplayStep(left: DisplayStep | undefined, right: DisplayStep | undefined): boolean {
  if (!left || !right) return left === right;
  return sameTraceStep(left, right) && sameToolEntry(left.localRequest, right.localRequest);
}

function indexTraceTurns(traceTurns: TraceTurn[]): Map<number, TraceTurn> {
  const byTurn = new Map<number, TraceTurn>();
  for (const traceTurn of traceTurns) {
    // Preserve Array.prototype.find semantics if malformed input contains duplicates.
    if (!byTurn.has(traceTurn.turn)) byTurn.set(traceTurn.turn, traceTurn);
  }
  return byTurn;
}

function indexLocalRequests(localProcessEntries: ToolProcessEntry[]): Map<number, ToolProcessEntry[]> {
  const byTurn = new Map<number, ToolProcessEntry[]>();
  for (const entry of localProcessEntries) {
    if (entry.name !== "请求模型") continue;
    const requests = byTurn.get(entry.turn);
    if (requests) requests.push(entry);
    else byTurn.set(entry.turn, [entry]);
  }
  return byTurn;
}

function reconcileSteps(
  previous: DisplayTurn | undefined,
  sourceTurn: TraceTurn | undefined,
  localRequests: ToolProcessEntry[],
  fallbackAssistant: TraceStep["assistant"] | undefined,
  turn: number,
): DisplayStep[] {
  const sourceSteps = sourceTurn?.steps || [];
  const steps: DisplayStep[] = sourceSteps.map((sourceStep) => ({ ...sourceStep, tools: [...sourceStep.tools] }));
  const sourceStepIndexes = new Map<number, number>();
  for (let index = 0; index < sourceSteps.length; index += 1) {
    if (!sourceStepIndexes.has(sourceSteps[index]!.step)) sourceStepIndexes.set(sourceSteps[index]!.step, index);
  }

  for (const localRequest of localRequests) {
    const sourceIndex = sourceStepIndexes.get(localRequest.step);
    let step = sourceIndex === undefined ? undefined : steps[sourceIndex];
    if (!step) {
      step = { turn, step: localRequest.step || 1, tools: [], completed: false };
      steps.push(step);
      // Keep the first matching step indexed so later local requests preserve Array.find semantics.
      sourceStepIndexes.set(step.step, steps.length - 1);
    }
    step.localRequest = localRequest;
  }

  // 结构化 trace 存在时只信任其中的 assistant/turn 终态；surface fallback 仅兼容完全无 trace 的旧会话。
  if (!sourceTurn && fallbackAssistant) {
    const step = steps.at(-1) || { turn, step: 1, tools: [], completed: false };
    if (!steps.includes(step)) steps.push(step);
    step.assistant = { ...fallbackAssistant, step: step.step };
  }
  if (sourceTurn?.error && steps.length === 0) steps.push({ turn, step: 1, tools: [], completed: false });
  steps.sort((left, right) => left.step - right.step);

  const previousByStep = new Map<number, DisplayStep[]>();
  for (const step of previous?.steps || []) {
    const sameStep = previousByStep.get(step.step);
    if (sameStep) sameStep.push(step);
    else previousByStep.set(step.step, [step]);
  }
  const consumed = new Map<number, number>();
  return steps.map((step) => {
    const candidates = previousByStep.get(step.step);
    const candidateIndex = consumed.get(step.step) || 0;
    const previousStep = candidates?.[candidateIndex];
    consumed.set(step.step, candidateIndex + 1);
    return previousStep && sameDisplayStep(previousStep, step) ? previousStep : step;
  });
}

function projectTurn(
  previous: DisplayTurn | undefined,
  user: MessageData,
  sourceTurn: TraceTurn | undefined,
  localRequests: ToolProcessEntry[],
  assistantTexts: string[],
  turn: number,
  runningTurn: number | undefined,
): DisplayTurn {
  const hasLegacyFinal = !sourceTurn && assistantTexts.length > 0;
  const fallbackAssistant = hasLegacyFinal
    ? { id: `live-assistant-${user.id}`, seq: Number.MAX_SAFE_INTEGER, turn, step: 1, text: assistantTexts.at(-1) || "", hasToolCalls: false }
    : undefined;
  const steps = reconcileSteps(previous, sourceTurn, localRequests, fallbackAssistant, turn);
  const status: DisplayTurn["status"] = sourceTurn?.terminal?.status === "failed"
    ? "failed"
    : sourceTurn?.terminal?.status === "cancelled"
      ? "cancelled"
      : sourceTurn?.terminal?.status === "rejected"
        ? "rejected"
        : sourceTurn?.terminal?.status === "timed_out"
          ? "timed_out"
          : sourceTurn?.terminal?.status === "completed" || hasLegacyFinal
      ? "completed"
      : runningTurn === turn
        ? "running"
        : "interrupted";
  const error = previous?.error && sameToolEntry(previous.error, sourceTurn?.error) ? previous.error : sourceTurn?.error;
  const terminal = previous?.terminal && sameTerminal(previous.terminal, sourceTurn?.terminal)
    ? previous.terminal
    : sourceTurn?.terminal;
  const trailingIncompleteStep = previous?.trailingIncompleteStep && sameIncomplete(previous.trailingIncompleteStep, sourceTurn?.trailingIncompleteStep)
    ? previous.trailingIncompleteStep
    : sourceTurn?.trailingIncompleteStep;
  if (previous
    && previous.turn === turn
    && previous.steps.length === steps.length
    && previous.steps.every((step, index) => step === steps[index])
    && previous.error === error
    && previous.terminal === terminal
    && previous.trailingIncompleteStep === trailingIncompleteStep
    && previous.hasStructuredTrace === Boolean(sourceTurn)
    && previous.status === status) return previous;
  return { turn, steps, error, terminal, trailingIncompleteStep, hasStructuredTrace: Boolean(sourceTurn), status };
}

export function createDisplayTurnProjector(): DisplayTurnProjector {
  let previousRows = new Map<string, DisplayTurnRow>();

  return {
    project(messages, traceTurns, localProcessEntries, turnOffset, conversationActive = false) {
      const traceByTurn = indexTraceTurns(traceTurns);
      const localRequestsByTurn = indexLocalRequests(localProcessEntries);
      const pending: Array<{ user: MessageData; sourceTurn?: TraceTurn; localRequests: ToolProcessEntry[]; assistantTexts: string[]; turn: number }> = [];
      let turnNumber = turnOffset;
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== "user") continue;
        const messageTurn = Number(message.turn);
        turnNumber = Number.isSafeInteger(messageTurn) && messageTurn > 0 ? messageTurn : turnNumber + 1;
        const assistant = assistantTextsAfter(messages, index);
        pending.push({
          user: message,
          sourceTurn: traceByTurn.get(turnNumber),
          localRequests: localRequestsByTurn.get(turnNumber) || [],
          assistantTexts: assistant.texts,
          turn: turnNumber,
        });
        index = assistant.nextIndex - 1;
      }

      let runningTurn: number | undefined;
      if (conversationActive) {
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const item = pending[index]!;
          const hasLegacyFinal = !item.sourceTurn && item.assistantTexts.length > 0;
          const isInterrupted = !hasLegacyFinal
            && item.sourceTurn?.terminal?.status !== "completed"
            && item.sourceTurn?.terminal?.status !== "failed"
            && item.sourceTurn?.terminal?.status !== "cancelled"
            && item.sourceTurn?.terminal?.status !== "rejected"
            && item.sourceTurn?.terminal?.status !== "timed_out";
          if (isInterrupted) {
            runningTurn = item.turn;
            break;
          }
        }
      }

      const nextRows = new Map<string, DisplayTurnRow>();
      const result = pending.map((item) => {
        const rowKey = displayTurnRowKey(item.turn, item.user);
        const previous = previousRows.get(rowKey);
        const projectedTurn = projectTurn(
          previous?.turn,
          item.user,
          item.sourceTurn,
          item.localRequests,
          item.assistantTexts,
          item.turn,
          runningTurn,
        );
        const stableUser = previous && sameMessage(previous.user, item.user) ? previous.user : item.user;
        const row = previous && stableUser === previous.user && projectedTurn === previous.turn
          ? previous
          : { user: stableUser, turn: projectedTurn };
        nextRows.set(rowKey, row);
        return row;
      });
      previousRows = nextRows;
      return result;
    },
  };
}

export function buildDisplayTurns(
  messages: MessageData[],
  traceTurns: TraceTurn[],
  localProcessEntries: ToolProcessEntry[],
  turnOffset: number,
  conversationActive = false,
): DisplayTurnRow[] {
  return createDisplayTurnProjector().project(messages, traceTurns, localProcessEntries, turnOffset, conversationActive);
}

export function nextDisplayTurn(messages: MessageData[], traceTurns: TraceTurn[]): number {
  const latestKnownTurn = Math.max(0, ...messages.map((message) => message.turn || 0), ...traceTurns.map((turn) => turn.turn));
  return latestKnownTurn > 0 ? latestKnownTurn + 1 : messages.filter((message) => message.role === "user").length + 1;
}

const AssistantStep = memo(function AssistantStep({
  step,
  turn,
  turnError,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  collapsed,
  turnStatus,
  messageRequest,
}: {
  step: DisplayStep;
  turn: number;
  turnError?: ToolProcessEntry;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  collapsed: boolean;
  turnStatus: DisplayTurn["status"];
  messageRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
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
          <div className="chat-message assistant"><div className="chat-message-content"><MarkdownMessage content={thinkingText} messageRequest={messageRequest} /></div></div>
        </div>
      )}

      {!hideProcess && step.tools.length > 0 && (
        <div className="agent-step-tools">
          {step.tools.map((part) => <div key={part.callId || part.id}><ToolPartView entry={part} /></div>)}
        </div>
      )}

      {finalText && (
        <div className="agent-step-intent agent-final-response">
          <div className="chat-message assistant">
            <div className="chat-message-label assistant-label">Agent</div>
            <div className="chat-message-content"><MarkdownMessage content={finalText} messageRequest={messageRequest} /></div>
          </div>
        </div>
      )}

      {stepPermissions.map((requestItem) => (
        <div key={requestItem.requestId}><PermissionRequestCard request={requestItem} resolving={resolvingPermissionId === requestItem.requestId} onResolvePermission={onResolvePermission} /></div>
      ))}

      {!hideProcess && turnError && <div className="agent-step-error">{turnError.result}</div>}
    </div>
  );
});

const TurnBlock = memo(function TurnBlock({
  turn,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  messageRequest,
}: {
  turn: DisplayTurn;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  messageRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
}) {
  // 只有明确完成且存在真实最终回复时默认折叠；运行、中断和失败都默认展开过程。
  const hasFinalResponse = shouldCollapseTurn(turn);
  // 用户手动设置的折叠状态；null 表示跟随默认策略
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  // 默认策略：完成且有最终回复才折叠。
  const collapsed = manualCollapsed ?? hasFinalResponse;

  const statusLabel = ({ running: "运行中", interrupted: "已中断", completed: "已完成", failed: "失败", cancelled: "已取消", rejected: "已拒绝", timed_out: "已超时" } as const)[turn.status];
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
            collapsed={collapsed}
            turnStatus={turn.status}
            messageRequest={messageRequest}
          />
        </Fragment>
      ))}
      {!collapsed && turn.status === "interrupted" && turn.trailingIncompleteStep && (
        <div className="agent-turn-interrupted">Turn {turn.turn} 在 Step {turn.trailingIncompleteStep.step} 的{phaseLabel}中断，未收到 turn/end。</div>
      )}
    </div>
  );
});

const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = [];

interface TranscriptTurnRowProps {
  user: MessageData;
  turn: DisplayTurn;
  permissionRequests: PermissionRequest[];
  resolvingPermissionId: string | null;
  onResolvePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  messageRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
}

const TranscriptTurnRow = memo(function TranscriptTurnRow({
  user,
  turn,
  permissionRequests,
  resolvingPermissionId,
  onResolvePermission,
  messageRequest,
}: TranscriptTurnRowProps) {
  return (
    <div className="transcript-turn-shell">
      <div className="transcript-turn-row">
        <div className="chat-message user transcript-user-message">
          <div className="chat-message-content"><MarkdownMessage content={user.content} messageRequest={messageRequest} /></div>
        </div>
        {(turn.hasStructuredTrace || turn.steps.length > 0) && (
          <TurnBlock
            turn={turn}
            permissionRequests={permissionRequests}
            resolvingPermissionId={resolvingPermissionId}
            onResolvePermission={onResolvePermission}
            messageRequest={messageRequest}
          />
        )}
      </div>
    </div>
  );
});

export default function Transcript(props: TranscriptProps) {
  const { draft, project, modelLabel, messages, traceTurns, localProcessEntries, turnOffset, permissionRequests, resolvingPermissionId, onResolvePermission, sending, conversationActive, onChangeProject, onLinkClick, messageRequest } = props;
  const displayTurnProjectorRef = useRef<DisplayTurnProjector | null>(null);
  if (!displayTurnProjectorRef.current) displayTurnProjectorRef.current = createDisplayTurnProjector();
  const displayTurns = useMemo(
    () => displayTurnProjectorRef.current!.project(messages, traceTurns, localProcessEntries, turnOffset, conversationActive || sending),
    [messages, traceTurns, localProcessEntries, turnOffset, conversationActive, sending],
  );
  const permissionRequestsByTurn = useMemo(() => {
    const grouped = new Map<number, PermissionRequest[]>();
    for (const request of permissionRequests) {
      const requests = grouped.get(request.turn);
      if (requests) requests.push(request);
      else grouped.set(request.turn, [request]);
    }
    return grouped;
  }, [permissionRequests]);
  const onResolvePermissionRef = useRef(onResolvePermission);
  onResolvePermissionRef.current = onResolvePermission;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const linkControllerRef = useRef<ReturnType<typeof createMarkdownLinkActivationController> | null>(null);
  if (!linkControllerRef.current) {
    linkControllerRef.current = createMarkdownLinkActivationController((info) => onLinkClickRef.current?.(info));
  }
  const linkHandlers = createMarkdownLinkActivationReactHandlers(linkControllerRef.current);
  const stableResolvePermission = useMemo(
    () => (requestId: string, outcome: PermissionOutcome) => onResolvePermissionRef.current(requestId, outcome),
    [],
  );
  return (
    <div
      className={`chat-surface ${draft ? "fresh" : ""}`}
      onPointerDownCapture={linkHandlers.onPointerDownCapture}
      onPointerMoveCapture={linkHandlers.onPointerMoveCapture}
      onPointerUpCapture={linkHandlers.onPointerUpCapture}
      onPointerCancelCapture={linkHandlers.onPointerCancelCapture}
      onClickCapture={linkHandlers.onClickCapture}
    >
      {draft && (
        <div className="new-thread-context">
          <span>▣ 当前项目</span>
          <strong title={project || undefined}>{project ? project.split("/").filter(Boolean).slice(-2).join(" / ") : "本地项目"}</strong>
          {onChangeProject && <button type="button" className="new-thread-change-project" onClick={onChangeProject}>更换目录</button>}
          <span>⚓ HubBert · {modelLabel}</span>
        </div>
      )}

      {displayTurns.map(({ user, turn }) => {
        const turnPermissionRequests = permissionRequestsByTurn.get(turn.turn) || EMPTY_PERMISSION_REQUESTS;
        const turnResolvingPermissionId = turnPermissionRequests.some((request) => request.requestId === resolvingPermissionId)
          ? resolvingPermissionId
          : null;
        return <TranscriptTurnRow
          key={user.id}
          user={user}
          turn={turn}
          permissionRequests={turnPermissionRequests}
          resolvingPermissionId={turnResolvingPermissionId}
          onResolvePermission={stableResolvePermission}
          messageRequest={messageRequest}
        />;
      })}

    </div>
  );
}
