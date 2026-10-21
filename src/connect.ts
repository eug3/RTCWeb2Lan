/**
 * Splash page logic (connect.html).
 *
 * Registers the overlay SW, connects over WebRTC (with retries — the very
 * first ICE attempt after e.g. a network change is sometimes slower than the
 * timeout), then hands the tab over to the real site root. The root page gets
 * a hidden holder iframe from the SW which keeps the tunnel alive after this
 * page unloads.
 */

import { connectFlow, ensureOurWorker, rememberEndpoint, type ConnectStage } from "./connect-flow.js";

const ASSET_BASE = (() => {
  const path = window.location.pathname;
  return path.endsWith("/") ? path.slice(0, -1) : path.replace(/\/[^/]*$/, "");
})();

const SW_URL = import.meta.env.DEV ? "/src/sw.ts" : ASSET_BASE + "/sw.js";

const MAX_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 15000;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const sceneEl = document.getElementById("scene") as unknown as SVGSVGElement;
const titleEl = el<HTMLHeadingElement>("title");
const stageEl = el<HTMLDivElement>("stage");
const attemptEl = el<HTMLDivElement>("attempt");
const failBox = el<HTMLDivElement>("failbox");
const reasonEl = el<HTMLDivElement>("reason");

const STAGE_TEXT: Record<string, string> = {
  signaling: "连接信令服务器…",
  connecting: "WebRTC 打洞中…",
  attaching: "接入数据面…",
  verifying: "验证隧道…",
};

interface Endpoint {
  signalUrl: string;
  room: string;
  stun: string;
}

function readEndpoint(): Endpoint {
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(location.search);
  return {
    signalUrl: params.get("signal") ?? wsScheme + "//" + location.host + ASSET_BASE + "/ws",
    room: params.get("room") ?? "lan",
    stun: params.get("stun") ?? "stun:stun.chat.bilibili.com:3478",
  };
}

const endpoint = readEndpoint();

function setStage(text: string, cls: "" | "ok" | "bad" = ""): void {
  stageEl.textContent = text;
  stageEl.style.color = cls === "ok" ? "#46d78a" : cls === "bad" ? "#ff9f8a" : "#ffd166";
}

function onStage(s: ConnectStage, attempt: number): void {
  if (s.stage === "done") {
    setStage("链路已焊通！正在进入…", "ok");
    return;
  }
  if (s.stage === "failed") {
    setStage("第 " + attempt + " 次尝试失败：" + s.reason, "bad");
    return;
  }
  setStage(STAGE_TEXT[s.stage] ?? "…");
}

function setCookie(name: string, maxAgeSec: number): void {
  document.cookie = name + "=1; path=/; max-age=" + maxAgeSec + "; SameSite=Lax";
}

const failures: string[] = [];

async function tryConnect(): Promise<boolean> {
  failures.length = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptEl.textContent = "尝试 " + attempt + " / " + MAX_ATTEMPTS;
    try {
      await connectFlow({
        ...endpoint,
        timeoutMs: CONNECT_TIMEOUT_MS,
        onStage: (s) => onStage(s, attempt),
      });
      return true;
    } catch (error) {
      failures.push(
        "#" + attempt + ": " + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return false;
}

function showFailure(): void {
  titleEl.textContent = "暂时没能焊上";
  setStage("P2P 建链失败，可以先经反代进入（nginx 中转）", "bad");
  attemptEl.textContent = "";
  reasonEl.textContent = failures.join("；");
  failBox.style.display = "block";
}

function finish(): void {
  sceneEl.classList.add("done");
  titleEl.textContent = "链路已焊通";
  // w2l_grace: while the SPA boots and its holder iframe reconnects, "/"
  // must pass through even though the overlay is briefly down.
  setCookie("w2l_grace", 60);
  document.cookie = "w2l_direct=; path=/; max-age=0; SameSite=Lax";
  setTimeout(() => location.replace("/"), 750);
}

async function boot(): Promise<void> {
  el<HTMLAnchorElement>("diag-link").href =
    ASSET_BASE + "/?signal=" + encodeURIComponent(endpoint.signalUrl) + "&room=" + encodeURIComponent(endpoint.room);

  el<HTMLButtonElement>("btn-retry").addEventListener("click", () => {
    failBox.style.display = "none";
    titleEl.textContent = "正在打通内网链路";
    sceneEl.classList.remove("done");
    void run();
  });
  el<HTMLButtonElement>("btn-enter").addEventListener("click", () => {
    setCookie("w2l_direct", 1800);
    location.replace("/");
  });

  if (!("serviceWorker" in navigator)) {
    setStage("浏览器不支持 Service Worker，直接进入…", "bad");
    setTimeout(() => location.replace("/"), 1200);
    return;
  }

  try {
    await navigator.serviceWorker.register(SW_URL, { type: "module", scope: "/" });
    // The host app's own worker (ngsw) may hold the scope; re-registering ours
    // replaces it (skipWaiting + claim). If it still won't yield, reload once.
    const ours = await ensureOurWorker(SW_URL, 8000);
    if (!ours && !sessionStorage.getItem("sw-war-reloaded")) {
      sessionStorage.setItem("sw-war-reloaded", "1");
      location.reload();
      return;
    }
  } catch (error) {
    setStage("SW 注册失败：" + (error instanceof Error ? error.message : String(error)), "bad");
    return;
  }

  if (!navigator.serviceWorker.controller && !sessionStorage.getItem("sw-reloaded")) {
    // First load after registering: reload once so this page is controlled.
    sessionStorage.setItem("sw-reloaded", "1");
    location.reload();
    return;
  }

  await rememberEndpoint(endpoint);
  void run();
}

async function run(): Promise<void> {
  const ok = await tryConnect();
  if (ok) finish();
  else showFailure();
}

void boot();
