import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const log = (...a) => console.log(...a);
setTimeout(() => { log("WATCHDOG"); process.exit(3); }, 90000).unref?.();
const PORT = 9339;
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
function makeCdp(ws) {
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  return (method, params, sessionId) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout " + method)); } }, 25000);
  });
}
async function openPage(cdp, url) {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  const ev = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  return { ev, sessionId, targetId };
}

// Build the in-page runner with an explicit role argument (no closure leakage).
function runner(role) {
  return `(async () => {
    const role = ${JSON.stringify(role)};
    const mod = await import("/src/peer.ts");
    const ch = new BroadcastChannel("sig-test-9339");
    const signaling = {
      send: (m) => ch.postMessage(m),
      onMessage: (h) => { ch.onmessage = (e) => h(e.data); },
    };
    // Empty ICE list => host candidates only, deterministic for a localhost test.
    const config = { iceServers: [], connectTimeoutMs: 25000 };
    try {
      const p = role === "initiator"
        ? await mod.connectAsInitiator({ session: "s1", signaling, config, deps: {} })
        : await mod.connectAsResponder({ session: "s1", signaling, config, deps: {} });
      window.__peer = p;
      window.__got = null;
      if (role === "responder") {
        p.channel.addEventListener("message", (e) => { window.__got = new TextDecoder().decode(e.data); });
      }
      return { ok: true, role, isRelayed: p.isRelayed, local: p.localCandidateType, remote: p.remoteCandidateType };
    } catch (e) { return { ok: false, role, err: String(e) }; }
  })()`;
}

try {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws err")); });
  const cdp = makeCdp(ws);

  const a = await openPage(cdp, "http://127.0.0.1:5273/");
  const b = await openPage(cdp, "http://127.0.0.1:5273/");
  await sleep(2500);

  // Responder must be listening before the initiator offers.
  const rbPromise = b.ev(runner("responder"));
  await sleep(600);
  const raPromise = a.ev(runner("initiator"));
  const [ra, rb] = await Promise.all([raPromise, rbPromise]);
  log("INITIATOR: " + JSON.stringify(ra));
  log("RESPONDER: " + JSON.stringify(rb));

  const sent = await a.ev(`(() => { const p = window.__peer; if (!p) return {err:"no peer"};
    p.channel.send(new TextEncoder().encode("hello-over-datachannel").buffer); return {ok:true}; })()`);
  log("SENT: " + JSON.stringify(sent));
  await sleep(2000);
  log("RESPONDER RECEIVED: " + JSON.stringify(await b.ev("window.__got ?? null")));
} catch (e) { log("ERROR " + e.message); } finally { chrome.kill("SIGKILL"); process.exit(0); }