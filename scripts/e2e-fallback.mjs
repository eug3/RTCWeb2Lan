import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const log = (...a) => console.log(...a);
setTimeout(() => { log("WATCHDOG"); process.exit(3); }, 150000).unref?.();
const PORT = 9370;
const profile = mkdtempSync(join(tmpdir(), "etw-fb-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--window-size=1180,1500", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout " + method)); } }, 40000);
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
  const statuses = async () => ev("({sw:document.getElementById('sw-status').textContent,dp:document.getElementById('dp-status').textContent,rtc:document.getElementById('rtc-status').textContent,path:document.getElementById('data-path').textContent,warn:document.getElementById('warn').textContent})");

  // ---------- TEST 1: P2P success ----------
  log("===== TEST 1: P2P 成功路径 =====");
  await send("Page.navigate", { url: "http://127.0.0.1:5273/?signal=" + encodeURIComponent("ws://127.0.0.1:8787/ws") + "&room=real" }, sessionId);
  await sleep(6000);
  for (let i = 0; i < 12; i++) { if (await ev("!!navigator.serviceWorker.controller") === true) break; await sleep(1200); }
  for (let i = 0; i < 30; i++) {
    const s = await statuses();
    if (s && !String(s.rtc).includes("连接中")) break;
    await sleep(1500);
  }
  log("STATUS: " + JSON.stringify(await statuses()));
  const t1 = await ev("fetch('/tunnel/sense/health').then(async r=>({url:r.url,status:r.status,body:(await r.text()).slice(0,120)})).catch(e=>({err:String(e)}))");
  log("TUNNEL PROBE: " + JSON.stringify(t1));

  // ---------- TEST 2: P2P failure -> fallback ----------
  log("");
  log("===== TEST 2: P2P 失败后回落 =====");
  await send("Page.navigate", { url: "http://127.0.0.1:5273/?signal=" + encodeURIComponent("ws://127.0.0.1:9999/ws") + "&room=none&timeout=2500" }, sessionId);
  await sleep(7000);
  for (let i = 0; i < 12; i++) { if (await ev("!!navigator.serviceWorker.controller") === true) break; await sleep(1200); }
  for (let i = 0; i < 20; i++) {
    const s = await statuses();
    if (s && (String(s.rtc).includes("回落") || String(s.rtc).includes("不可用"))) break;
    await sleep(1000);
  }
  log("STATUS: " + JSON.stringify(await statuses()));
  // With SW disabled, a request must pass straight to the origin (vite), not the tunnel.
  const t2 = await ev("fetch('/package.json').then(async r=>({url:r.url,status:r.status,isJson:(await r.text()).startsWith('{')})).catch(e=>({err:String(e)}))");
  log("PASSTHROUGH PROBE: " + JSON.stringify(t2));
  const t3 = await ev("fetch('/tunnel/sense/health').then(async r=>({url:r.url,status:r.status,ct:r.headers.get('content-type')})).catch(e=>({err:String(e)}))");
  log("OVERLAY-DISABLED PROBE (should be html/404 from origin, NOT intranet): " + JSON.stringify(t3));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  writeFileSync("/tmp/etw-fallback.png", Buffer.from(shot.data, "base64"));
  log("SHOT /tmp/etw-fallback.png");
} catch (e) { log("ERROR " + e.message); } finally { chrome.kill("SIGKILL"); process.exit(0); }