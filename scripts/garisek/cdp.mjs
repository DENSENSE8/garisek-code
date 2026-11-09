// Minimal Chrome DevTools Protocol client for driving the Garisek Electron window
// (launched with --remote-debugging-port). Shared by e2e-harness.mjs and paint-bench.mjs.
const KEY_CODES = { Enter: 13, Escape: 27 };

export async function connectPage(cdpBase) {
  const pages = await (await fetch(`${cdpBase}/json/list`)).json();
  const target = pages.find((candidate) => candidate.type === "page");
  if (!target) throw new Error(`no page target at ${cdpBase}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(`${method}: ${message.error.message}`))
          : resolve(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page threw: ${detail}`);
    }
    return result.result.value;
  };
  const pressKey = async (key) => {
    const event = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key] };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  };
  return {
    send,
    evaluate,
    pressKey,
    onEvent: (listener) => listeners.add(listener),
    close: () => socket.close(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chat actions on a Garisek page: click by visible text, and send a turn then wait until it settles.
export function chatDriver(page, { turnTimeoutMs }) {
  const js = (value) => JSON.stringify(value);
  const clickByText = (selector, predicateSource) =>
    page.evaluate(`(() => {
      const match = [...document.querySelectorAll(${js(selector)})]
        .filter((element) => (${predicateSource})(element.innerText.replace(/\\s+/g, " ").trim(), element))
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!match) return false;
      match.scrollIntoView({ block: "center" });
      match.click();
      return true;
    })()`);

  // The timeline is virtualized, so row counts are meaningless: read the assistant rows that follow
  // the newest user row carrying this turn's prompt.
  const repliesAfter = (prompt) =>
    page.evaluate(`(() => {
      const scroll = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Scroll to end");
      if (scroll) scroll.click();
      const norm = (s) => s.replace(/\\s+/g, " ").trim();
      const head = norm(${js(prompt)}).slice(0, 60);
      const rows = [...document.querySelectorAll("[data-timeline-row-id]")];
      let anchor = -1;
      rows.forEach((row, index) => {
        if (row.getAttribute("data-message-role") === "user" && norm(row.innerText).includes(head)) anchor = index;
      });
      if (anchor < 0) return null;
      return rows.slice(anchor + 1).filter((row) => row.getAttribute("data-message-role") === "assistant").map((row) => row.innerText.trim());
    })()`);

  const isRunning = () =>
    page.evaluate(`(() => {
      if ([...document.querySelectorAll("button[aria-label]")].some((button) => /^(stop|interrupt)/i.test(button.getAttribute("aria-label")))) return true;
      return /Working for \\d/.test(document.querySelector("main")?.innerText ?? document.body.innerText);
    })()`);

  async function sendTurn(text, expect) {
    const focused = await page.evaluate(`(() => {
      const editor = document.querySelector('[data-testid="composer-editor"]');
      if (!editor) return false;
      editor.focus();
      return true;
    })()`);
    if (!focused) throw new Error("composer editor not found");
    await page.send("Input.insertText", { text });
    await sleep(300);
    await page.pressKey("Enter");
    const sentAt = new Date().toISOString();
    const deadline = Date.now() + turnTimeoutMs;
    let lastText = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const replies = await repliesAfter(text);
      const failed = await page.evaluate(
        `[...document.querySelectorAll("main *")].some((element) => element.childElementCount === 0 && /^Provider turn failed/.test(element.textContent ?? ""))`,
      );
      if (failed && !replies?.length) throw new Error("UI reports: Provider turn failed");
      if (!replies?.length || (await isRunning())) continue;
      const joined = replies.join("\n---\n");
      if (joined !== lastText) {
        lastText = joined;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 6000) {
        const reply = replies.at(-1);
        if (expect && !expect(reply)) throw new Error(`unexpected reply: ${reply.slice(0, 400)}`);
        return { sentAt, settledAt: new Date().toISOString(), reply };
      }
    }
    throw new Error(`turn did not settle within ${turnTimeoutMs / 1000}s`);
  }

  async function openNewThread(projectName) {
    if (
      !(await clickByText(
        "button",
        `(text, element) => element.getAttribute("aria-label") === "New thread"`,
      ))
    )
      throw new Error("New thread button not found");
    await sleep(1200);
    await page.send("Input.insertText", { text: projectName });
    await sleep(1000);
    await page.pressKey("Enter");
    await sleep(1500);
    const heading = await page.evaluate(`document.querySelector("main")?.innerText ?? ""`);
    if (!heading.includes(projectName)) throw new Error(`project ${projectName} was not selected`);
  }

  async function selectRef(ref) {
    if (
      !(await clickByText(
        '[role="combobox"]',
        `(text, element) => !element.getAttribute("aria-label") && text.length > 0 && text.length < 120 && element.closest("main") !== null && !/,/.test(text)`,
      ))
    )
      throw new Error("ref picker not found");
    await sleep(1000);
    await page.send("Input.insertText", { text: ref });
    await sleep(1000);
    await page.pressKey("Enter");
    await sleep(1500);
    const refShown = await page.evaluate(
      `[...document.querySelectorAll('[role="combobox"]')].some((element) => element.innerText.replace(/\\s+/g, "") === ${js(ref)})`,
    );
    if (!refShown) throw new Error(`worktree ref ${ref} was not selected`);
  }

  async function selectModel(modelOption) {
    const family = modelOption.split(",")[0].trim();
    if (
      !(await clickByText(
        "main form button[aria-label]",
        `(text, element) => /^[^,]+, [^,]+$/.test(element.getAttribute("aria-label") ?? "")`,
      ))
    )
      throw new Error("model picker button not found");
    await sleep(800);
    await page.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="Search models..."]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(family)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(800);
    if (!(await clickByText('[role="option"]', `(text) => text.startsWith(${js(modelOption)})`)))
      throw new Error(`model option "${modelOption}" not found`);
    await sleep(500);
    await page.pressKey("Escape");
    const label = await page.evaluate(
      `[...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).find((l) => l.startsWith(${js(family)}))`,
    );
    if (!label) throw new Error("model selection did not stick");
    return label;
  }

  return { clickByText, openNewThread, selectModel, selectRef, sendTurn };
}
