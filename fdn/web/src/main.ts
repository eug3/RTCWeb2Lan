/**
 * Demo bootstrap.
 *
 * Wires: Service Worker -> page-side data plane -> WebRTC DataChannel -> agent.
 *
 * The page is the WebRTC initiator: it joins the signaling room, offers, and on
 * success hands the connection to the SW through a MessagePort.
 */

import { attachDataPlane, instanceFromPeer } from "./data-plane.js";
import { connectAsInitiator, type PeerConnectionHandle, type SignalChannel } from "./peer.js";
import { loadAndApplyConfig } from "./config-loader.js";
import { DEFAULT_SITE_CONFIG, DEFAULT_SIGNALING_PROFILE, type SignalingProfile, type SiteProfile } from "./config.js";
import type { SignalMessage } from "./signaling.js";

/**
 * Base URL for our assets.
 *
 * The page may be mounted under a sub-path (e.g. /__lan/) while the real site
 * lives at the origin root. Registering "/sw.js" blindly would look for a file
 * that does not exist there, so derive the SW path from this page's own
 * directory.
 */
const ASSET_BASE = (() => {
  const path = window.location.pathname;
  // "/__lan/" -> "/__lan" ; "/" -> ""
  return path.endsWith("/") ? path.slice(0, -1) : path.replace(/\/[^/]*$/, "");
})();

const SW_URL = import.meta.env.DEV ? "/src/sw.ts" : ASSET_BASE + "/sw.js";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const swStatus = el<HTMLSpanElement>("sw-status");
const dpStatus = el<HTMLSpanElement>("dp-status");
const rtcStatus = el<HTMLSpanElement>("rtc-status");
const out = el<HTMLPreElement>("out");
const locEl = el<HTMLElement>("loc");
const resUrlEl = el<HTMLElement>("res-url");
const leakEl = el<HTMLSpanElement>("leak");

function setStatus(node: HTMLElement, text: string, cls: "ok" | "bad" | "idle") {
  node.textContent = text;
  node.className = "status " + cls;
}

/**
 * How long we wait for a usable P2P link before falling back to nginx.
 *
 * Cross-network ICE needs several seconds: STUN discovery, candidate exchange
 * and connectivity checks. 4s was observed to cut off a healthy handshake.
 */
const P2P_PROBE_TIMEOUT_MS = 15000;

/**
 * Path used to verify the tunnel, from the site config (default "/"). Any HTTP
 * status proves the tunnel round-tripped; see probeTunnel.
 */
let siteProfile: SiteProfile = DEFAULT_SITE_CONFIG.site;
let signalingProfile: SignalingProfile = DEFAULT_SIGNALING_PROFILE;

const dataPath = el<HTMLSpanElement>("data-path");
const warnProbe = el<HTMLDivElement>("warn");

// --------------------------------------------------------------- data plane

async function attachToServiceWorker(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("service worker 未激活");

  const channel = new MessageChannel();
  const peer = currentPeer;
  if (!peer) throw new Error("尚未建立 WebRTC 连接");

  attachDataPlane(channel.port1, instanceFromPeer(peer));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("接入数据面超时")), 15000);
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const d = event.data as { type?: string; message?: string };
      if (d?.type === "overlay:port-attached") {
        clearTimeout(timer);
        resolve();
      } else if (d?.type === "overlay:port-error") {
        clearTimeout(timer);
        reject(new Error(d.message));
      }
    });
    sw.postMessage({ type: "overlay:attach-port" }, [channel.port2]);
  });
}

// -------------------------------------------------------------- signaling

let currentPeer: PeerConnectionHandle | null = null;

/** Wraps a WebSocket as the SignalChannel peer.ts expects. */
function makeSignalChannel(ws: WebSocket): SignalChannel {
  const handlers: Array<(m: SignalMessage) => void> = [];
  ws.addEventListener("message", (event) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const m = msg as SignalMessage & { state?: string; type?: string };
    // The relay's "ready" frames are informational; ignore them here.
    if (m.type === "ready" || m.type === "waiting") return;
    for (const h of handlers) h(m);
  });
  return {
    send: (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    onMessage: (h) => {
      handlers.push(h);
    },
  };
}

/** Ask the SW to start or stop intercepting. */
async function setOverlayEnabled(enabled: boolean): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("service worker 未激活");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SW 未响应")), 5000);
    const handler = (event: MessageEvent) => {
      const d = event.data as { type?: string };
      if (d?.type === "overlay:enabled" || d?.type === "overlay:disabled") {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    sw.postMessage({ type: enabled ? "overlay:enable" : "overlay:disable" });
  });
}

/** True when a request actually came back through the overlay. */
async function probeOverlay(): Promise<boolean> {
  try {
    const res = await fetch(siteProfile.probePath, { cache: "no-store", redirect: "manual" });
    // Any HTTP answer proves the tunnel works; the agent decides the status.
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Connect over WebRTC, then switch the SW over to overlay mode — but only if the
 * link is actually usable. Otherwise leave the SW disabled so requests go
 * straight to the origin through nginx (graceful degradation, no TURN needed).
 */
async function connect(options: {
  signalUrl: string;
  room: string;
  stun: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? P2P_PROBE_TIMEOUT_MS;
  setStatus(rtcStatus, "连接中…", "idle");

  const url = new URL(options.signalUrl);
  url.searchParams.set("room", options.room);
  url.searchParams.set("role", "browser");

  const ws = new WebSocket(url.toString());

  let peer: PeerConnectionHandle;
  try {
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("信令连接失败")), { once: true });
      }),
      timeoutMs,
      "信令连接",
    );

    // Give the relay a moment to pair both sides before offering.
    await delay(400);

    const iceServers = options.stun
      ? options.stun.split(",").map((s) => ({ urls: s.trim() })).filter((s) => s.urls)
      : [];

    peer = await withDeadline(
      connectAsInitiator({
        session: options.room,
        signaling: makeSignalChannel(ws),
        config: { iceServers, connectTimeoutMs: timeoutMs },
        deps: {},
      }),
      timeoutMs + 2000,
      "WebRTC 连接",
    );
  } catch (error) {
    // Fall back: keep the SW out of the way so the origin (nginx) serves us.
    await setOverlayEnabled(false).catch(() => {});
    setStatus(rtcStatus, "P2P 不可用，已回落反代", "idle");
    setStatus(dpStatus, "未启用（走 nginx 反代）", "idle");
    warnProbe.textContent =
      "P2P 建链失败，已自动回落为直连（经 nginx）。原因：" +
      (error instanceof Error ? error.message : String(error));
    throw error;
  }

  currentPeer = peer;
  const kind = peer.isRelayed ? "经 TURN 中转" : "P2P 直连";
  setStatus(rtcStatus, "已连接（" + kind + "，local=" + (peer.localCandidateType ?? "?") + "）", "ok");

  await attachToServiceWorker();
  await setOverlayEnabled(true);

  // Confirm the tunnel really carries traffic before trusting it.
  const ok = await probeOverlay();
  if (!ok) {
    await setOverlayEnabled(false).catch(() => {});
    setStatus(dpStatus, "隧道探测失败，已回落反代", "bad");
    throw new Error("overlay probe failed");
  }

  setStatus(dpStatus, "已接入（P2P）", "ok");
  setStatus(dataPath, "P2P 直连", "ok");
  warnProbe.textContent = "";
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + " 超时（" + ms + "ms）")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ probes

async function probe(url: string) {
  const started = performance.now();
  out.textContent = "请求 " + url + " …";
  try {
    const res = await fetch(url);
    const text = await res.text();
    resUrlEl.textContent = res.url || "(tunneled: 无 URL)";
    const leaked = /10\.\d+\.\d+\.\d+|192\.168\.|172\.(1[6-9]|2\d|3[01])\./.test(res.url);
    setStatus(leakEl, leaked ? "泄露！" : "无泄露 ✓", leaked ? "bad" : "ok");

    out.textContent = [
      "请求 URL   : " + url,
      "响应 URL   : " + (res.url || "(tunneled)"),
      "状态       : " + res.status + " " + res.statusText,
      "类型       : " + (res.headers.get("content-type") ?? "(none)"),
      "耗时       : " + (performance.now() - started).toFixed(1) + " ms",
      "",
      text.slice(0, 1500),
    ].join("\n");
  } catch (error) {
    out.textContent = "请求失败：" + (error instanceof Error ? error.message : String(error));
  }
}

// ------------------------------------------------------------------ wiring

el("btn-api").addEventListener("click", () => probe("/tunnel/154/api/ping"));
el("btn-page").addEventListener("click", () => probe("/tunnel/154/page"));
el("btn-pass").addEventListener("click", () => probe("/package.json"));
el("btn-img").addEventListener("click", () => probe("/tunnel/154/logo.png"));

el("btn-connect").addEventListener("click", () => {
  const signalUrl = (el<HTMLInputElement>("in-signal")).value;
  const room = (el<HTMLInputElement>("in-room")).value;
  const stun = (el<HTMLInputElement>("in-stun")).value;
  // Expected failures (no P2P) already set the fallback status inside connect().
  void connect({ signalUrl, room, stun }).catch(() => {});
});

async function boot() {
  locEl.textContent = location.href;
  // Defaults derived from where the page is actually served, so a deployed
  // build works without hard-coded localhost values.
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const defaultSignal = wsScheme + "//" + location.host + ASSET_BASE + "/ws";
  const defaultStun = signalingProfile.stun;

  el<HTMLInputElement>("in-signal").value = defaultSignal;
  el<HTMLInputElement>("in-stun").value = defaultStun;

  const params = new URLSearchParams(location.search);
  if (params.get("signal")) el<HTMLInputElement>("in-signal").value = params.get("signal")!;
  if (params.get("room")) el<HTMLInputElement>("in-room").value = params.get("room")!;
  if (params.get("stun")) el<HTMLInputElement>("in-stun").value = params.get("stun")!;

  if (!("serviceWorker" in navigator)) {
    setStatus(swStatus, "浏览器不支持", "bad");
    return;
  }

  try {
    // scope MUST be "/": we tunnel /api/* at the origin root, which is also
    // where the host app's own service worker lives. Registering here replaces
    // it (browser allows one SW per scope) — an accepted trade-off: the PWA
    // cache is useless once data comes live over the overlay.
    const reg = await navigator.serviceWorker.register(SW_URL, { type: "module", scope: "/" });
    await navigator.serviceWorker.ready;
    setStatus(swStatus, "已激活（scope=" + reg.scope + "）", "ok");
  } catch (error) {
    setStatus(swStatus, "注册失败：" + (error instanceof Error ? error.message : String(error)), "bad");
    return;
  }

  if (!navigator.serviceWorker.controller) {
    if (!sessionStorage.getItem("sw-reloaded")) {
      sessionStorage.setItem("sw-reloaded", "1");
      location.reload();
    }
    return;
  }

  // Load deployment config and hand it to the SW before any tunnelling. A
  // failure keeps defaults (no intranet addresses; the agent resolves routes).
  const loadedConfig = await loadAndApplyConfig(ASSET_BASE).catch(() => DEFAULT_SITE_CONFIG);
  siteProfile = loadedConfig.site;
  signalingProfile = loadedConfig.signaling;
  // Reflect config-driven signaling defaults into the form (query params already applied above win only if the user typed them; keep their value).
  const stunInput = el<HTMLInputElement>("in-stun");
  if (!params.get("stun")) stunInput.value = signalingProfile.stun;
  const roomInput = el<HTMLInputElement>("in-room");
  if (!params.get("room") && roomInput) roomInput.value = signalingProfile.room;

  // Auto-connect when the URL carries signaling parameters.
  //
  // Failure here is NOT an error state: connect() already switched the SW back
  // to pass-through, so the page is being served by nginx as usual. The status
  // line explains which path was taken.
  if (params.get("signal") && params.get("room")) {
    void connect({
      signalUrl: params.get("signal")!,
      room: params.get("room")!,
      stun: params.get("stun") ?? "",
      timeoutMs: Number(params.get("timeout") ?? P2P_PROBE_TIMEOUT_MS),
    });
  }
}

void boot();

(window as unknown as Record<string, unknown>).attachOverlayToServiceWorker = attachToServiceWorker;
(window as unknown as Record<string, unknown>).overlayConnect = connect;