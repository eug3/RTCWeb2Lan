/**
 * Shared connect flow used by the splash page (connect.html) and the hidden
 * holder iframe. The /__lan/ index page keeps its own copy wired to its
 * diagnostics UI on purpose — do not couple them.
 *
 * Flow: signaling WebSocket -> WebRTC offer/answer -> attach data-plane port
 * to the SW -> enable interception -> verify the tunnel actually carries
 * traffic. Any failure must leave the SW disabled (nginx fallback).
 */

import { attachDataPlane, instanceFromPeer } from "./data-plane.js";
import { connectAsInitiator, type PeerConnectionHandle, type SignalChannel } from "./peer.js";
import type { SignalMessage } from "./signaling.js";

export function makeSignalChannel(ws: WebSocket): SignalChannel {
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

export async function attachPortToServiceWorker(peer: PeerConnectionHandle): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("service worker 未激活");

  const channel = new MessageChannel();
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

export async function setOverlayEnabled(enabled: boolean): Promise<void> {
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

export interface OverlayStatus {
  enabled: boolean;
  hasTransport: boolean;
  /**
   * False when the Service Worker did not answer within the deadline. Callers
   * MUST NOT treat that as "the tunnel is dead": an unanswered query means we
   * do not know, and acting on it tears down healthy connections.
   */
  answered: boolean;
}

export async function queryOverlayStatus(): Promise<OverlayStatus> {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("service worker 未激活");
  return new Promise<OverlayStatus>((resolve) => {
    // No answer is NOT evidence of a dead tunnel: a busy or restarting Service
    // Worker can miss the reply. Report "unknown" and let the caller decide.
    const timer = setTimeout(() => resolve({ enabled: false, hasTransport: false, answered: false }), 4000);
    const handler = (event: MessageEvent) => {
      const d = event.data as { type?: string; enabled?: boolean; hasTransport?: boolean };
      if (d?.type === "overlay:status-reply") {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve({ enabled: !!d.enabled, hasTransport: !!d.hasTransport, answered: true });
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    sw.postMessage({ type: "overlay:status" });
  });
}

/** Tell the SW which endpoint we used, so injected holders reconnect the same way. */
export async function rememberEndpoint(endpoint: {
  signalUrl: string;
  room: string;
  stun: string;
}): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({
    type: "overlay:set-endpoint",
    signalUrl: endpoint.signalUrl,
    room: endpoint.room,
    stun: endpoint.stun,
  });
}

/**
 * Make sure OUR worker is the active one for scope "/".
 *
 * The host app (Angular PWA) registers its own service worker (ngsw-worker.js)
 * on the same scope; one registration replaces the other. When the app steals
 * the scope, re-register ours — its install (skipWaiting) + activate (claim)
 * handlers take over again.
 */
export async function ensureOurWorker(
  swUrl: string,
  maxWaitMs = 10000,
): Promise<boolean> {
  // Callers pass a path ("/__lan/sw.js"); the registration stores an absolute
  // URL. Compare resolved URLs or the equality never holds.
  const ours = new URL(swUrl, location.href).href;
  const readActive = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.scriptURL ?? null;
  };
  if ((await readActive()) === ours) return true;

  await navigator.serviceWorker.register(swUrl, { type: "module", scope: "/" });
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if ((await readActive()) === ours) return true;
    await delay(400);
  }
  return false;
}

/**
 * Tunnel verification.
 *
 * nginx (the fallback path) stamps a `server` header on proxied replies; the
 * Go agent does not. A tunneled reply therefore has no `server` header — a
 * passthrough reply does. Any HTTP status proves the round-trip.
 *
 * Must carry its own timeout: a connected-but-dead peer (wedged agent) never
 * answers, and without a deadline the whole connect flow would hang forever.
 */
export async function probeTunnel(path = "/", timeoutMs = 8000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { cache: "no-store", redirect: "manual", signal: controller.signal });
    if (res.status <= 0) return false;
    // Evidence that the SW intercepted: either a tunnel reply (no `server`
    // header) or one of our fallback markers — the 401 fallback replays via
    // nginx (which stamps `server`), so the marker alone also proves the
    // overlay path executed.
    return res.headers.get("x-w2l") !== null || res.headers.get("server") === null;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type ConnectStage =
  | { stage: "signaling" }
  | { stage: "connecting" }
  | { stage: "attaching" }
  | { stage: "verifying" }
  | { stage: "done"; kind: string }
  | { stage: "failed"; reason: string };

export interface ConnectFlowOptions {
  signalUrl: string;
  room: string;
  stun: string;
  timeoutMs?: number;
  probePath?: string;
  onStage?: (s: ConnectStage) => void;
}

export interface ConnectFlowResult {
  peer: PeerConnectionHandle;
}

/** How long we wait for a usable P2P link per attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

export async function connectFlow(options: ConnectFlowOptions): Promise<ConnectFlowResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const onStage = options.onStage ?? (() => {});

  onStage({ stage: "signaling" });
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

    onStage({ stage: "connecting" });
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
    const reason = error instanceof Error ? error.message : String(error);
    onStage({ stage: "failed", reason });
    throw error;
  }

  onStage({ stage: "attaching" });
  try {
    await attachPortToServiceWorker(peer);
    await setOverlayEnabled(true);

    onStage({ stage: "verifying" });
    const ok = await probeTunnel(options.probePath);
    if (!ok) {
      peer.close();
      await setOverlayEnabled(false).catch(() => {});
      throw new Error("隧道探测失败");
    }
  } catch (error) {
    await setOverlayEnabled(false).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    onStage({ stage: "failed", reason });
    throw error;
  }

  const kind = peer.isRelayed ? "经 TURN 中转" : "P2P 直连";
  onStage({ stage: "done", kind });
  return { peer };
}

export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + " 超时（" + ms + "ms）")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
