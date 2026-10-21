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
import { withTimeout, type OverlayTransport } from "./transport.js";
import { createMockTransport } from "./mock-transport.js";
import { PortOverlayTransport } from "./port-transport.js";

declare const self: ServiceWorkerGlobalScope;

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

let config: OverlayConfig = { rules: DEFAULT_RULES, exchangeTimeoutMs: 120_000 };

/**
 * Master switch for interception.
 *
 * The page probes for a working P2P link on load and only turns this on when the
 * link is up. When P2P is unavailable the SW must NOT intercept, so requests
 * fall through to the real network (the site behind nginx), which is the
 * graceful degradation path: no TURN relay, no broken pages.
 */
let overlayEnabled = false;

let transport: OverlayTransport | null = null;
let portTransport: PortOverlayTransport | null = null;

function getTransport(): OverlayTransport {
  transport ??= createMockTransport();
  return transport;
}

function attachDataPlanePort(port: MessagePort): void {
  portTransport?.dispose();
  portTransport = new PortOverlayTransport(port);
  transport = portTransport;
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; config?: Partial<OverlayConfig> } | undefined;

  if (data?.type === "overlay:configure" && data.config) {
    config = { ...config, ...data.config };
    if (Array.isArray(data.config.apiPrefixes) && data.config.apiPrefixes.length > 0) {
      apiPrefixes = data.config.apiPrefixes;
    }
    event.source?.postMessage({ type: "overlay:configured", rules: config.rules });
    return;
  }

  if (data?.type === "overlay:enable") {
    overlayEnabled = true;
    event.source?.postMessage({ type: "overlay:enabled" });
    return;
  }

  if (data?.type === "overlay:disable") {
    overlayEnabled = false;
    portTransport?.dispose();
    portTransport = null;
    transport = null;
    event.source?.postMessage({ type: "overlay:disabled" });
    return;
  }

  if (data?.type === "overlay:status") {
    event.source?.postMessage({ type: "overlay:status-reply", enabled: overlayEnabled });
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

function shouldTunnel(pathname: string): boolean {
  return apiPrefixes.some((p) => pathname.startsWith(p));
}

self.addEventListener("fetch", (event: FetchEvent) => {
  // Pass everything through until the page confirms a live P2P link.
  if (!overlayEnabled) return;

  const url = new URL(event.request.url);
  // Never hijack our own control page or the signalling socket.
  if (url.pathname.startsWith("/__lan")) return;
  if (!shouldTunnel(url.pathname)) return;

  const route = resolveRoute(url.hostname, url.pathname, url.search, config.rules);
  if (route === null) return;
  event.respondWith(tunnel(event.request, route));
});

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
    responseBytes = await withTimeout(
      getTransport().exchange(route.authority, wire),
      config.exchangeTimeoutMs,
      "overlay exchange with " + route.authority,
    );
  } catch (error) {
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

  return toResponse(request, parsed);
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const DROPPED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function toResponse(request: Request, parsed: ReturnType<typeof parseResponse>): Response {
  const headers = new Headers();
  for (const [name, value] of parsed.headers) {
    if (DROPPED.has(name.toLowerCase())) continue;
    try {
      headers.append(name, value);
    } catch {
      // ignore header names the Fetch layer refuses
    }
  }
  const nullBody = request.method === "HEAD" || parsed.status === 204 || parsed.status === 304;
  return new Response(nullBody ? null : (parsed.body as unknown as BodyInit), {
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
  });
}