import assert from "node:assert/strict";
import test from "node:test";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { createMarkdownLinkActivationReactHandlers, createMarkdownLinkActivationController, handleMarkdownLinkActivation, originalLinkTarget, renderMarkdownHtml } from "./transcript.js";

const dom = new JSDOM("");
const purifier = createDOMPurify(dom.window as unknown as WindowLike);

function renderLink(markdown: string): HTMLAnchorElement {
  const html = renderMarkdownHtml(markdown, (dirty: string, config: { ADD_ATTR: string[] }) => (
    String(purifier.sanitize(dirty, config as Config))
  ));
  const document = new JSDOM(html).window.document;
  const anchor = document.querySelector("a");
  assert.ok(anchor, `expected an anchor in ${html}`);
  return anchor;
}

test("preserves file URL as broadcast data while navigation uses a safe placeholder", () => {
  const href = "file:///Users/test/.dsh/settings.yaml";
  const anchor = renderLink(`[settings](${href})`);

  assert.equal(originalLinkTarget(anchor), href);
  assert.equal(anchor.getAttribute("data-original-href"), href);
  assert.equal(anchor.getAttribute("href"), "#");
});

test("preserves relative and https targets exactly", () => {
  for (const href of ["../docs/readme.md?mode=raw#install", "https://example.com/a?b=1&c=2#d"]) {
    const anchor = renderLink(`[open](${href})`);
    assert.equal(originalLinkTarget(anchor), href);
    assert.equal(anchor.getAttribute("data-original-href"), href);
    assert.equal(anchor.getAttribute("href"), "#");
  }
});

test("preserves a custom protocol for consumers while navigation uses a safe placeholder", () => {
  const href = "harbors://plugin/open?id=chat";
  const anchor = renderLink(`[open plugin](${href})`);

  assert.equal(originalLinkTarget(anchor), href);
  assert.equal(anchor.getAttribute("data-original-href"), href);
  assert.equal(anchor.getAttribute("href"), "#");
});

test("broadcast data may contain javascript but executable navigation stays sanitized", () => {
  const href = "javascript:alert(1)";
  const anchor = renderLink(`[unsafe](<${href}>)`);

  // Chat 只广播原始字符串，由消费者决定协议；DOM 中没有可执行 href。
  assert.equal(originalLinkTarget(anchor), href);
  assert.equal(anchor.getAttribute("data-original-href"), href);
  assert.equal(anchor.getAttribute("href"), "#");
  assert.equal(anchor.getAttribute("onclick"), null);
});

test("click activation prevents placeholder navigation and broadcasts the original target", () => {
  const href = "file:///Users/test/.dsh/settings.yaml";
  const anchor = renderLink(`[settings](${href})`);
  const child = anchor.appendChild(anchor.ownerDocument.createElement("span"));
  let prevented = false;
  let stopped = false;
  let broadcast: { href: string; text: string } | undefined;

  const handled = handleMarkdownLinkActivation({
    target: child,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  }, (info) => { broadcast = info; });

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(broadcast?.href, href);
});

function pointerEvent(
  target: EventTarget,
  overrides: Partial<Pick<PointerEvent, "pointerId" | "pointerType" | "isPrimary" | "button" | "clientX" | "clientY">> = {},
): PointerEvent {
  return {
    target,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  } as unknown as PointerEvent;
}

function clickEvent(target: EventTarget, detail: number, button = 0): MouseEvent & { prevented: boolean; stopped: boolean } {
  const event = {
    target,
    detail,
    button,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  return event as unknown as MouseEvent & { prevented: boolean; stopped: boolean };
}

for (const pointerType of ["mouse", "touch"]) {
  test(`${pointerType} pointer activation broadcasts once after its synthetic click`, () => {
    const anchor = renderLink(`[open](file:///tmp/test.txt)`);
    const broadcasts: string[] = [];
    const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));
    controller.pointerDown(pointerEvent(anchor, { pointerType }));
    controller.pointerUp(pointerEvent(anchor, { pointerType }));
    const click = clickEvent(anchor, 1);
    controller.click(click);

    assert.deepEqual(broadcasts, ["file:///tmp/test.txt"]);
    assert.equal(click.prevented, true);
    assert.equal(click.stopped, true);
  });
}

test("pointerup with button -1 still activates once through its synthetic click", () => {
  const anchor = renderLink(`[open](file:///tmp/test.txt)`);
  const broadcasts: string[] = [];
  const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));
  controller.pointerDown(pointerEvent(anchor, { button: 0 }));
  controller.pointerUp(pointerEvent(anchor, { button: -1 }));
  controller.click(clickEvent(anchor, 1));

  assert.deepEqual(broadcasts, ["file:///tmp/test.txt"]);
});

test("Transcript chat-surface React capture handlers activate a mounted link", () => {
  const appDom = new JSDOM('<div class="message-list-container"><div class="chat-surface"><a href="#" data-original-href="https://arxiv.org/abs/2608.17389">paper</a></div></div>');
  const document = appDom.window.document;
  const anchor = document.querySelector("a");
  assert.ok(anchor);
  const broadcasts: string[] = [];
  const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));
  const handlers = createMarkdownLinkActivationReactHandlers(controller);

  const pointer = (type: string, button: number): void => {
    const event = new appDom.window.Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    Object.assign(event, { pointerId: 1, pointerType: "mouse", isPrimary: true, button, clientX: 10, clientY: 10 });
    Object.defineProperty(event, "target", { value: anchor });
    if (type === "pointerdown") handlers.onPointerDownCapture(event as unknown as PointerEvent);
    if (type === "pointerup") handlers.onPointerUpCapture({ nativeEvent: event as unknown as PointerEvent });
  };
  pointer("pointerdown", 0);
  pointer("pointerup", -1);
  const click = new appDom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: -1 });
  Object.defineProperty(click, "target", { value: anchor });
  handlers.onClickCapture({ nativeEvent: click });

  assert.deepEqual(broadcasts, ["https://arxiv.org/abs/2608.17389"]);
  assert.equal(click.defaultPrevented, true);
});

test("React capture adapters accept native events without nativeEvent", () => {
  const appDom = new JSDOM('<div class="chat-surface"><a href="#" data-original-href="https://example.test/native">native</a></div>');
  const anchor = appDom.window.document.querySelector("a");
  assert.ok(anchor);
  const broadcasts: string[] = [];
  const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));
  const handlers = createMarkdownLinkActivationReactHandlers(controller);
  const event = (type: string, button: number): PointerEvent => {
    const value = new appDom.window.Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    Object.assign(value, { pointerId: 1, pointerType: "mouse", isPrimary: true, button, clientX: 10, clientY: 10 });
    Object.defineProperty(value, "target", { value: anchor });
    return value as unknown as PointerEvent;
  };
  handlers.onPointerDownCapture(event("pointerdown", 0));
  handlers.onPointerUpCapture(event("pointerup", -1));
  const click = new appDom.window.MouseEvent("click", { button: -1 });
  Object.defineProperty(click, "target", { value: anchor });
  handlers.onClickCapture(click);

  assert.deepEqual(broadcasts, ["https://example.test/native"]);
});

test("keyboard click is handled as a fallback activation", () => {
  const anchor = renderLink(`[open](harbors://plugin/open)`);
  const broadcasts: string[] = [];
  const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));
  const click = clickEvent(anchor, 0);
  controller.click(click);

  assert.deepEqual(broadcasts, ["harbors://plugin/open"]);
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
});

test("non-primary pointer and drag do not broadcast", () => {
  const anchor = renderLink(`[open](file:///tmp/test.txt)`);
  const broadcasts: string[] = [];
  const controller = createMarkdownLinkActivationController((info) => broadcasts.push(info.href));

  controller.pointerDown(pointerEvent(anchor, { button: 2 }));
  controller.pointerUp(pointerEvent(anchor, { button: 2 }));
  controller.click(clickEvent(anchor, 1, 2));

  controller.pointerDown(pointerEvent(anchor));
  controller.pointerMove(pointerEvent(anchor, { clientX: 30 }));
  controller.pointerUp(pointerEvent(anchor, { clientX: 30 }));
  const dragClick = clickEvent(anchor, 1);
  controller.click(dragClick);

  assert.deepEqual(broadcasts, []);
  assert.equal(dragClick.prevented, true);
});
