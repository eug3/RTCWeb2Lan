import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const log = (...a) => console.log(...a);
setTimeout(() => { log("WATCHDOG"); process.exit(3); }, 80000).unref?.();
const PORT = 9337;
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout " + method)); } }, 15000);
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
  for (let i = 0; i < 12; i++) {
    if (await ev("!!navigator.serviceWorker.controller") === true) break;
    await sleep(1000);
  }
  const results = {};
  results.controller = await ev("navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null");
  results.attach = await ev("window.attachOverlayToServiceWorker().then(r=>({ok:r})).catch(e=>({err:String(e)}))");
  results.viaPort = await ev("Promise.race([fetch('/tunnel/154/api/x').then(async r=>({resUrl:r.url,status:r.status,ct:r.headers.get('content-type'),body:await r.text()})).catch(e=>({err:String(e)})), new Promise(r=>setTimeout(()=>r({timeout:true}),10000))])");
  results.location = await ev("location.href");
  log("RESULTS " + JSON.stringify(results, null, 2));
} catch (e) { log("ERROR " + e.message); } finally { chrome.kill("SIGKILL"); process.exit(0); }