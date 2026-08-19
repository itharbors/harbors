import assert from "node:assert/strict";
import test from "node:test";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { createMarkdownLinkActivationController, handleMarkdownLinkActivation, originalLinkTarget, renderMarkdownHtml } from "./transcript.js";

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
