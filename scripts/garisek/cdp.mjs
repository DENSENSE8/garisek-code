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
