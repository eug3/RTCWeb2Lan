import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const log = (...a) => console.log(...a);
setTimeout(() => { log("WATCHDOG"); process.exit(3); }, 100000).unref?.();
const PORT = 9355;
const profile = mkdtempSync(join(tmpdir(), "etw-real230-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--window-size=1100,1450", "about:blank",
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout " + method)); } }, 35000);
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

  const url = "http://127.0.0.1:5273/?signal=" + encodeURIComponent("ws://127.0.0.1:8787/ws") + "&room=real";
  await send("Page.navigate", { url }, sessionId);
  await sleep(5500);
  for (let i = 0; i < 12; i++) {
    if (await ev("!!navigator.serviceWorker.controller") === true) break;
    await sleep(1200);
  }
  for (let i = 0; i < 25; i++) {
    const t = await ev("document.getElementById('rtc-status').textContent");
    if (typeof t === "string" && (t.includes("已连接") || t.includes("失败"))) break;
    await sleep(1200);
  }
  log("RTC: " + JSON.stringify(await ev("document.getElementById('rtc-status').textContent")));

  // Real intranet request through the tunnel.
  const probe = await ev(`fetch('/tunnel/154/health').then(async r => ({url:r.url,status:r.status,ct:r.headers.get('content-type'),body:(await r.text()).slice(0,300)})).catch(e => ({err:String(e)}))`);
  log("HEALTH: " + JSON.stringify(probe));

  const root = await ev(`fetch('/tunnel/154/').then(async r => ({url:r.url,status:r.status,ct:r.headers.get('content-type'),len:(await r.text()).length})).catch(e => ({err:String(e)}))`);
  log("ROOT: " + JSON.stringify(root));

  await ev(`fetch('/tunnel/154/').then(async r => { const t = await r.text(); document.getElementById('out').textContent = ['请求 URL   : /tunnel/154/','响应 URL   : '+r.url,'状态       : '+r.status,'类型       : '+(r.headers.get('content-type')||''),'长度       : '+t.length+' bytes','',''+t.slice(0,600)].join('\n'); document.getElementById('res-url').textContent=r.url; const leaked=/10\.1\.1\.\d+/.test(r.url); document.getElementById('leak').textContent=leaked?'泄露！':'无泄露 ✓'; document.getElementById('leak').className='status '+(leaked?'bad':'ok'); })`);
  await sleep(1500);
  log("OUT:" + String.fromCharCode(10) + (await ev("document.getElementById('out').textContent")));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  writeFileSync("/tmp/etw-230.png", Buffer.from(shot.data, "base64"));
  log("SHOT /tmp/etw-230.png");
} catch (e) { log("ERROR " + e.message); } finally { chrome.kill("SIGKILL"); process.exit(0); }
