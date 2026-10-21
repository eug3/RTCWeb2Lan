
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const log = (...a) => console.log(...a);
setTimeout(() => { log("WATCHDOG"); process.exit(3); }, 60000).unref?.();
const PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), "etw-chrome-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("devtools unreachable");
}
try {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws err")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout " + method)); } }, 12000);
  });
  const { targetInfos } = await send("Target.getTargets", {});
  const page = targetInfos.find(t => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  await send("Page.navigate", { url: "http://127.0.0.1:5273/" }, sessionId);
  await sleep(4000);
  // Try registering explicitly and capture the REAL error
  const reg = await ev(`navigator.serviceWorker.register('/src/sw.ts', {type:'module', scope:'/'})
    .then(r => ({ok:true, scope:r.scope, installing: !!r.installing, active: !!r.active, waiting: !!r.waiting}))
    .catch(e => ({ok:false, name:e.name, message:e.message, stack:String(e.stack).slice(0,300)}))`);
  log("REGISTER: " + JSON.stringify(reg, null, 2));
  log("STATUS TEXT: " + JSON.stringify(await ev("document.getElementById('status').textContent")));
  await sleep(2000);
  log("GETREG: " + JSON.stringify(await ev("navigator.serviceWorker.getRegistration().then(r=>r?{scope:r.scope,installing:!!r.installing,waiting:!!r.waiting,active:!!r.active}:null)")));
  log("CONTROLLER: " + JSON.stringify(await ev("navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null")));
} catch (e) { log("ERROR " + e.message); } finally { chrome.kill("SIGKILL"); process.exit(0); }
