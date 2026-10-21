/**
 * Hidden holder iframe — keeps the P2P data plane alive for its tab.
 *
 * Injected into the site root HTML by the Service Worker (fetchWithHolder).
 * The iframe outlives nothing by itself; its job is to hold the
 * RTCPeerConnection + MessagePort so that navigating between pages of the tab
 * never tears the tunnel down, and to re-establish it when it drops.
 *
 * Multiple tabs means multiple holders; the signaling room has a single
 * browser slot, so they must not race: every candidate waits a random jitter
 * and re-checks the overlay status before connecting, and any holder that sees
 * the overlay enabled stands down (its peer would replace the live one and
 * break the room pairing).
 */

import {
  connectFlow,
  delay,
  ensureOurWorker,
  probeTunnel,
  queryOverlayStatus,
  rememberEndpoint,
  setOverlayEnabled,
} from "./connect-flow.js";
import type { PeerConnectionHandle } from "./peer.js";

const ASSET_BASE = (() => {
  const path = window.location.pathname;
  return path.endsWith("/") ? path.slice(0, -1) : path.replace(/\/[^/]*$/, "");
})();

const SW_URL = import.meta.env.DEV ? "/src/sw.ts" : ASSET_BASE + "/sw.js";

function defaultEndpoint(): { signalUrl: string; room: string; stun: string } {
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(location.search);
  return {
    signalUrl: params.get("signal") ?? wsScheme + "//" + location.host + ASSET_BASE + "/ws",
    room: params.get("room") ?? "lan",
    stun: params.get("stun") ?? "stun:stun.chat.bilibili.com:3478",
  };
}

const endpoint = defaultEndpoint();
const log = (...args: unknown[]) => console.info("[holder]", ...args);

let peer: PeerConnectionHandle | null = null;
let connecting = false;
let backoffMs = 2000;
let deadSince = 0;

/**
 * Connect when the overlay is down. Status-first: a peer we still hold may be
 * orphaned (its owning SW instance was replaced in the registration war), so
 * an overlay that reports "not enabled" invalidates our peer.
 */
async function ensureConnected(): Promise<void> {
  const status = await queryOverlayStatus();
  if (status.enabled) return; // the tunnel is served — stand down

  if (peer) {
    // Orphaned peer (SW instance replaced): release it before reconnecting.
    peer.close();
    peer = null;
  }
  if (connecting) return;

  connecting = true;
  // Election jitter: with several tabs open, only one holder should hit the
  // signaling room; the others re-check after their jitter and stand down.
  await delay(300 + Math.random() * 1500);

  const recheck = await queryOverlayStatus();
  if (recheck.enabled) {
    connecting = false;
    return;
  }

  try {
    log("connecting", endpoint.room);
    const result = await connectFlow({ ...endpoint });
    peer = result.peer;
    backoffMs = 2000;
    deadSince = 0;
    log("tunnel up");
  } catch (error) {
    log("connect failed:", error instanceof Error ? error.message : String(error));
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 15000);
  } finally {
    connecting = false;
  }
}

/**
 * Watch our own peer: a dead PC does not close the SW MessagePort (this page
 * is still alive), so without this the SW would keep intercepting into a dead
 * tunnel and every request would hang until its 120s timeout.
 */
async function watchPeer(): Promise<void> {
  if (!peer) return;
  const state = peer.connectionState();
  if (state === "connected" || state === "connecting" || state === "new") {
    deadSince = 0;
    return;
  }
  if (!deadSince) {
    deadSince = Date.now();
    return;
  }
  if (Date.now() - deadSince < 4000) return; // brief ICE restarts are normal

  log("peer dead (" + state + "), releasing overlay");
  peer.close();
  peer = null;
  deadSince = 0;
  await setOverlayEnabled(false).catch(() => {});
}

async function onOverlayDown(): Promise<void> {
  // The SW told us the transport port closed (its owning page went away).
  if (peer) {
    peer.close();
    peer = null;
  }
}

async function periodicHealthCheck(): Promise<void> {
  if (!peer) return;
  // Cheap liveness probe through the tunnel; a failing probe means the path
  // is broken even though the PC object still looks fine.
  const ok = await probeTunnel();
  if (!ok) {
    log("health probe failed");
    if (peer) {
      peer.close();
      peer = null;
    }
    await setOverlayEnabled(false).catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register(SW_URL, { type: "module", scope: "/" }).catch(() => {});
  await ensureOurWorker(SW_URL);
  await rememberEndpoint(endpoint);

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const d = event.data as { type?: string };
    if (d?.type === "overlay:down") void onOverlayDown();
  });

  setInterval(() => {
    void (async () => {
      // Registration war self-heal: if the host app's worker took the scope
      // back, re-register ours; only then can the overlay mean anything.
      if (!(await ensureOurWorker(SW_URL, 3000))) return;
      await ensureConnected();
      await watchPeer();
    })().catch(() => {});
  }, 2500);
  setInterval(() => void periodicHealthCheck(), 20000);

  void ensureConnected();
}

void main();
