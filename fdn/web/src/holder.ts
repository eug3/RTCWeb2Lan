/**
 * Hidden holder iframe — keeps the P2P data plane alive for its tab.
 *
 * Injected into the site root HTML by the Service Worker (fetchWithHolder).
 * The iframe outlives nothing by itself; its job is to hold the
 * RTCPeerConnection + MessagePort so that navigating between pages of the tab
 * never tears the tunnel down, and to re-establish it when it drops.
 *
 * The relay now gives each browser its own agent connection and the agent keys
 * its peer connections by session id, so several tabs (or a tablet alongside a
 * laptop) each keep their own tunnel instead of evicting one another. Holders
 * still wait a random jitter and stand down when the overlay is already up —
 * not to avoid clobbering a shared slot, but because a tab whose data plane is
 * already live has no reason to open a second one.
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
import { applySetCookies } from "./cookie-relay.js";
import { loadAndApplyConfig } from "./config-loader.js";
import { decidePeerAction } from "./overlay-policy.js";
import { DEFAULT_SITE_CONFIG, DEFAULT_SIGNALING_PROFILE, type SignalingProfile, type SiteProfile } from "./config.js";
import type { PeerConnectionHandle } from "./peer.js";

const ASSET_BASE = (() => {
  const path = window.location.pathname;
  return path.endsWith("/") ? path.slice(0, -1) : path.replace(/\/[^/]*$/, "");
})();

const SW_URL = import.meta.env.DEV ? "/src/sw.ts" : ASSET_BASE + "/sw.js";

function defaultEndpoint(signaling: SignalingProfile): { signalUrl: string; room: string; stun: string } {
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(location.search);
  return {
    signalUrl: params.get("signal") ?? wsScheme + "//" + location.host + ASSET_BASE + "/ws",
    // Query string still wins (handy for one-off tests); otherwise use config.
    room: params.get("room") ?? signaling.room,
    stun: params.get("stun") ?? signaling.stun,
  };
}

// Initialised from defaults; recomputed from config once it loads in main().
let endpoint = defaultEndpoint(DEFAULT_SIGNALING_PROFILE);
const log = (...args: unknown[]) => console.info("[holder]", ...args);

/** Site behaviour (probe path etc.), populated from config at startup. */
let siteProfile: SiteProfile = DEFAULT_SITE_CONFIG.site;

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
  // "enabled" alone can be a stale SW state (the owning page died without the
  // port close event firing). Only a live transport means the tunnel is real.
  // An UNANSWERED status query means we do not know — not that the tunnel is
  // dead. Killing the peer on a missed reply caused a reconnect storm: the
  // holder built a healthy connection, failed to hear back within 4s, closed
  // it, and rebuilt immediately, so requests queued behind a connection that
  // never lived long enough to carry them. See overlay-policy.ts.
  const action = decidePeerAction(status, peer !== null);
  if (action === "stand-down" || action === "keep-peer") return;
  if (action === "release-and-reconnect" && peer) {
    // Explicitly reported down (SW instance replaced): release before reconnecting.
    peer.close();
    peer = null;
  }
  if (connecting) return;

  connecting = true;
  // Jitter before dialing: a tab that is already connected should not open a
  // second tunnel just because its holder remounted.
  await delay(300 + Math.random() * 1500);

  const recheck = await queryOverlayStatus();
  if (recheck.enabled && recheck.hasTransport) {
    connecting = false;
    return;
  }

  try {
    log("connecting", endpoint.room);
    const result = await connectFlow({ ...endpoint });
    peer = result.peer;
    backoffMs = 2000;
    deadSince = 0;
    healthFailures = 0;
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
  // "disconnected" is often a transient ICE flap (WiFi/EasyTier jitter); give
  // it a generous grace before tearing the tunnel down.
  if (!deadSince) {
    deadSince = Date.now();
    return;
  }
  if (Date.now() - deadSince < 15000) return;

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

let healthFailures = 0;

async function periodicHealthCheck(): Promise<void> {
  if (!peer) return;
  // Cheap liveness probe through the tunnel; a failing probe means the path
  // is broken even though the PC object still looks fine. Boot bursts queue
  // exchanges, so a single slow probe is noise — only two in a row count.
  const ok = await probeTunnel(siteProfile.probePath, 15000);
  if (ok) {
    healthFailures = 0;
    return;
  }
  healthFailures++;
  log("health probe failed (" + healthFailures + "/2)");
  if (healthFailures < 2) return;
  healthFailures = 0;
  log("tunnel dead, releasing overlay");
  if (peer) {
    peer.close();
    peer = null;
  }
  await setOverlayEnabled(false).catch(() => {});
}

async function main(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register(SW_URL, { type: "module", scope: "/" }).catch(() => {});
  await ensureOurWorker(SW_URL);
  await rememberEndpoint(endpoint);

  // Load deployment config and hand it to the SW before we start tunnelling.
  // A failure here keeps the defaults (no intranet addresses, ask the agent).
  const config = await loadAndApplyConfig(ASSET_BASE).catch(() => DEFAULT_SITE_CONFIG);
  siteProfile = config.site;
  endpoint = defaultEndpoint(config.signaling);

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const d = event.data as { type?: string; cookies?: string[] };
    if (d?.type === "overlay:down") void onOverlayDown();
    // Set-Cookie relay: the SW cannot set cookies on synthesized responses, so
    // tunneled login cookies are assigned here (same-origin hidden iframe).
    if (d?.type === "w2l:set-cookie" && Array.isArray(d.cookies)) {
      const n = applySetCookies(d.cookies);
      if (n > 0) log("relayed", n, "set-cookie header(s)");
    }
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
