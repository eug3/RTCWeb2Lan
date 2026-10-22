/// <reference lib="webworker" />
/**
 * Overlay Service Worker — URL-preserving.
 *
 * Requests whose host/path matches a route are serialized to HTTP/1.1, handed to
 * the overlay transport (one DataChannel per request), and the reply is turned
 * back into a Response. Everything else falls through untouched.
 */

import { resolveRoute, type RouteRule } from "./router.js";
import { encodeRequest, parseResponse } from "./http1.js";
import { withTimeout } from "./transport.js";
import { PortOverlayTransport } from "./port-transport.js";
import {
  decideNavigation,
  injectHolderIntoHtml,
  REWRITTEN_HTML_DROP_HEADERS,
} from "./nav-gate.js";
import { extractSetCookies } from "./cookie-relay.js";

declare const self: ServiceWorkerGlobalScope;

/** Resolve a shipped page URL next to the SW script.
 *
 * Production ships everything in one directory (e.g. /__lan/); in vite dev the
 * SW is served from /src/sw.ts while the HTML entries live at the root.
 */
function pageUrl(name: string): URL {
  const base = self.location.pathname.includes("/src/")
    ? new URL("/", self.location.href)
    : new URL("./", self.location.href);
  return new URL(name, base);
}

const CONNECT_URL = pageUrl("connect.html");
const HOLDER_URL = pageUrl("holder.html");

export interface OverlayConfig {
  rules: RouteRule[];
  exchangeTimeoutMs?: number;
  /** Path prefixes to tunnel. Defaults to ["/api/"]. */
  apiPrefixes?: string[];
}

// In prefix mode the agent resolves the real intranet target from its own route
// table (routes.yaml), so the browser only needs to say WHICH public host it is
// standing in for. The authority here is a logical key, not an IP to dial.
const DEFAULT_RULES: RouteRule[] = [
  { kind: "host", host: "sense.jshuaxin.net", target: { ipv4: "10.1.1.230", port: 9011 } },
  // publicHost tells the agent which site this stands for; it resolves the
  // intranet address itself from routes.yaml.
  { kind: "prefix", host: "127.0.0.1", prefix: "/tunnel/sense", target: { ipv4: "10.1.1.230", port: 9011 }, publicHost: "sense.jshuaxin.net" },
  { kind: "prefix", host: "localhost", prefix: "/tunnel/sense", target: { ipv4: "10.1.1.230", port: 9011 }, publicHost: "sense.jshuaxin.net" },
  { kind: "prefix", host: "127.0.0.1", prefix: "/tunnel/154", target: { ipv4: "10.1.1.154", port: 80 } },
  { kind: "prefix", host: "localhost", prefix: "/tunnel/154", target: { ipv4: "10.1.1.154", port: 80 } },
];

// Generous because it also covers the data plane's serial exchange queue during
// SPA boot bursts; true port death is detected faster by PortOverlayTransport's
// own internal timeout.
let config: OverlayConfig = { rules: DEFAULT_RULES, exchangeTimeoutMs: 45_000 };

/** Last signaling endpoint a page used, so injected holders reconnect the same way. */
let endpoint: { signalUrl: string; room: string; stun: string } | null = null;

/**
 * Master switch for interception.
 *
 * The page probes for a working P2P link on load and only turns this on when the
 * link is up. When P2P is unavailable the SW must NOT intercept, so requests
 * fall through to the real network (the site behind nginx), which is the
 * graceful degradation path: no TURN relay, no broken pages.
 */
let overlayEnabled = false;

let portTransport: PortOverlayTransport | null = null;

function attachDataPlanePort(port: MessagePort): void {
  portTransport?.dispose();
  portTransport = new PortOverlayTransport(port);
  portTransport.onClose = () => {
    // The page holding the peer connection went away: stop intercepting at
    // once (fallback to nginx) and ask a surviving holder to reconnect.
    overlayEnabled = false;
    void notifyOverlayDown();
  };
}

/**
 * A failed exchange almost always means the data plane is dead (the page that
 * owned the peer connection went away and the port close event never fired).
 * Failing every request for 120s each would wedge the SPA on boot; instead
 * drop the overlay immediately so requests fall back to nginx while the holder
 * reconnects.
 */
function dropDeadTransport(): void {
  overlayEnabled = false;
  portTransport?.dispose();
  portTransport = null;
  void notifyOverlayDown();
}

async function notifyOverlayDown(): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "overlay:down" });
  }
}

function holderUrl(): string {
  if (!endpoint) return HOLDER_URL.href;
  const url = new URL(HOLDER_URL.href);
  url.searchParams.set("signal", endpoint.signalUrl);
  url.searchParams.set("room", endpoint.room);
  if (endpoint.stun) url.searchParams.set("stun", endpoint.stun);
  return url.href;
}

function connectUrl(): string {
  if (!endpoint) return CONNECT_URL.href;
  const url = new URL(CONNECT_URL.href);
  url.searchParams.set("signal", endpoint.signalUrl);
  url.searchParams.set("room", endpoint.room);
  if (endpoint.stun) url.searchParams.set("stun", endpoint.stun);
  return url.href;
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as
    | {
        type?: string;
        config?: Partial<OverlayConfig>;
        signalUrl?: string;
        room?: string;
        stun?: string;
      }
    | undefined;

  if (data?.type === "overlay:configure" && data.config) {
    config = { ...config, ...data.config };
    if (Array.isArray(data.config.apiPrefixes) && data.config.apiPrefixes.length > 0) {
      apiPrefixes = data.config.apiPrefixes;
    }
    event.source?.postMessage({ type: "overlay:configured", rules: config.rules });
    return;
  }

  if (data?.type === "overlay:set-endpoint" && data.signalUrl && data.room) {
    endpoint = { signalUrl: data.signalUrl, room: data.room, stun: data.stun ?? "" };
    event.source?.postMessage({ type: "overlay:endpoint-set" });
    return;
  }

  if (data?.type === "overlay:enable") {
    // Never intercept without a live data plane: without this guard a stray
    // enable (e.g. a holder racing a drop) silently serves mock responses.
    if (!portTransport || !portTransport.isReady) {
      event.source?.postMessage({ type: "overlay:enable-rejected", reason: "no data plane" });
      return;
    }
    overlayEnabled = true;
    event.source?.postMessage({ type: "overlay:enabled" });
    return;
  }

  if (data?.type === "overlay:disable") {
    overlayEnabled = false;
    portTransport?.dispose();
    portTransport = null;
    event.source?.postMessage({ type: "overlay:disabled" });
    return;
  }

  if (data?.type === "overlay:status") {
    event.source?.postMessage({
      type: "overlay:status-reply",
      enabled: overlayEnabled,
      hasTransport: portTransport !== null && portTransport.isReady,
    });
    return;
  }

  if (data?.type === "overlay:attach-port") {
    const port = event.ports[0];
    if (!port) return;
    attachDataPlanePort(port);
    void portTransport
      ?.waitReady(15_000)
      .then(() => event.source?.postMessage({ type: "overlay:port-attached" }))
      .catch((error: Error) =>
        event.source?.postMessage({ type: "overlay:port-error", message: error.message }),
      );
  }
});

/**
 * Which requests are tunnelled.
 *
 * Only API calls go over the overlay; static assets stay on nginx, which is
 * both faster (cached, CDN-able) and avoids the "<base href> rewrites the asset
 * path" problem entirely. Override with the `apiPrefixes` config field.
 */
let apiPrefixes: string[] = ["/api/"];

/**
 * Paths that must always consult the origin. The auth-state endpoint reports
 * login via a 200 body instead of 401, so it cannot self-heal through the
 * 401 fallback — and the tunnel cannot carry the browser's httpOnly session
 * cookie. Asking the origin lets the browser answer with its own cookie.
 */
const NEVER_TUNNEL = ["/api/auth/session"];

function shouldTunnel(pathname: string): boolean {
  if (NEVER_TUNNEL.some((p) => pathname === p || pathname.startsWith(p + "/"))) return false;
  return apiPrefixes.some((p) => pathname.startsWith(p));
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // Never hijack our own control pages or the signalling socket.
  if (url.pathname.startsWith("/__lan")) return;

  // Splash gate: a cold visit to the site root shows the connecting page;
  // once the tunnel is up, the root HTML gets a hidden holder iframe that
  // keeps the data plane alive for the lifetime of the tab.
  if (event.request.mode === "navigate") {
    const decision = decideNavigation({
      pathname: url.pathname,
      enabled: overlayEnabled,
      cookieHeader: event.request.headers.get("cookie"),
    });

    if (decision === "connect-page") {
      event.respondWith(Response.redirect(connectUrl(), 302));
      return;
    }
    if (decision === "inject-holder") {
      event.respondWith(fetchWithHolder(event.request));
      return;
    }
    return; // passthrough
  }

  // Pass everything through until the page confirms a live P2P link.
  if (!overlayEnabled) return;
  if (!shouldTunnel(url.pathname)) return;

  const route = resolveRoute(url.hostname, url.pathname, url.search, config.rules);
  if (route === null) return;
  event.respondWith(tunnel(event.request, route));
});

/** Fetch the real document and plant the holder iframe before </body>. */
async function fetchWithHolder(request: Request): Promise<Response> {
  // fetch() rejects Request objects whose mode is "navigate"; rebuild it as a
  // plain same-origin GET (navigations are always GET).
  const reqHeaders = new Headers();
  for (const name of ["accept", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) reqHeaders.set(name, value);
  }
  const upstream = new Request(request.url, {
    method: "GET",
    headers: reqHeaders,
    credentials: "same-origin",
    redirect: "follow",
  });

  const response = await fetch(upstream);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  const injected = injectHolderIntoHtml(html, holderUrl());
  if (injected === null) return response;

  const headers = new Headers();
  response.headers.forEach((value, name) => {
    if (!REWRITTEN_HTML_DROP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function tunnel(
  request: Request,
  route: NonNullable<ReturnType<typeof resolveRoute>>,
): Promise<Response> {
  let bodyBytes: Uint8Array | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) bodyBytes = new Uint8Array(buf);
  }

  const headers: Array<[string, string]> = [...request.headers.entries()];
  const wire = encodeRequest(
    { method: request.method, path: route.upstreamPath, headers, body: bodyBytes },
    route.hostHeader,
  );

  let responseBytes: Uint8Array;
  try {
    const t = portTransport;
    if (!t) throw new Error("no data plane attached");
    responseBytes = await withTimeout(
      t.exchange(route.authority, wire),
      config.exchangeTimeoutMs,
      "overlay exchange with " + route.authority,
    );
  } catch (error) {
    dropDeadTransport();
    // GET/HEAD have no side effects, so serving them from the origin beats a
    // 504 during the reconnect window. POSTs may already have been executed
    // upstream (request delivered, reply lost) and are not replayed.
    if (request.method === "GET" || request.method === "HEAD") {
      const viaOrigin = await replayViaOrigin(request, "fallback");
      if (viaOrigin) return viaOrigin;
    }
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(504, "overlay error: " + message);
  }

  let parsed;
  try {
    parsed = parseResponse(responseBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(502, "bad overlay response: " + message);
  }

  // A tunnelled request cannot carry the browser's httpOnly session cookie
  // (the SW cannot read it off the Request), so a session the browser holds
  // looks logged-out on the agent path. A 401 means the server rejected the
  // request without side effects, so replaying via the origin — where the
  // browser attaches its cookie natively — is safe for every method and
  // keeps both paths in sync.
  if (parsed.status === 401) {
    const viaOrigin = await replayViaOrigin(request, "401-fallback");
    if (viaOrigin) return viaOrigin;
  }

  return toResponse(request, parsed);
}

/**
 * Re-fetch an intercepted request straight from the origin (the browser
 * attaches cookies natively) and tag the reply so tooling can tell the
 * paths apart. Returns null when the origin attempt itself fails.
 */
async function replayViaOrigin(request: Request, marker: string): Promise<Response | null> {
  try {
    const origin = await fetch(request);
    const headers = new Headers(origin.headers);
    headers.set("x-w2l", marker);
    return new Response(origin.body, {
      status: origin.status,
      statusText: origin.statusText,
      headers,
    });
  } catch {
    return null;
  }
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const DROPPED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

/**
 * Forward tunneled Set-Cookie headers to the window clients. The holder iframe
 * assigns them via document.cookie so the browser shares the session with the
 * nginx passthrough path (see src/cookie-relay.ts for why the SW cannot set
 * them on the Response itself).
 */
async function relaySetCookies(cookies: string[]): Promise<void> {
  if (cookies.length === 0) return;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "w2l:set-cookie", cookies });
  }
}

function toResponse(request: Request, parsed: ReturnType<typeof parseResponse>): Response {
  const headers = new Headers();
  const setCookies = extractSetCookies(parsed.headers);
  for (const [name, value] of parsed.headers) {
    if (DROPPED.has(name.toLowerCase())) continue;
    try {
      headers.append(name, value);
    } catch {
      // ignore header names the Fetch layer refuses
    }
  }
  const nullBody = request.method === "HEAD" || parsed.status === 204 || parsed.status === 304;
  void relaySetCookies(setCookies);
  return new Response(nullBody ? null : (parsed.body as unknown as BodyInit), {
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
  });
}