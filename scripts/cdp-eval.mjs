// 迷你 CDP 驱动：连到远程调试端口执行 JS 或截图。
// 用法:
//   node scripts/cdp-eval.mjs eval  <port> <expression>
//   node scripts/cdp-eval.mjs shot  <port> <输出.png> [等待毫秒]

const [, , mode, port, a1, a2] = process.argv;
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
// 优先匹配应用页面（127.0.0.1），避免抓到浏览器自身的对话框 target
const page =
  list.find((t) => t.type === "page" && t.url.includes("127.0.0.1")) ??
  list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    setTimeout(() => rej(new Error("cdp timeout: " + method)), 20000);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

if (mode === "eval") {
  const r = await send("Runtime.evaluate", { expression: a1, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result));
} else if (mode === "shot") {
  if (a2) await new Promise((r) => setTimeout(r, Number(a2)));
  const r = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(a1, Buffer.from(r.result.data, "base64"));
  console.log("saved", a1);
} else {
  console.error("unknown mode");
  process.exit(1);
}
ws.close();
process.exit(0);
