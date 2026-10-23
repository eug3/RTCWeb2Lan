/**
 * Overlay configuration contract.
 *
 * Everything that used to be hard-wired (which hosts are tunnelled, which
 * intranet targets they map to, which paths must bypass the tunnel, where the
 * version probe points) lives here in one declarative shape. Deployments can
 * override it at runtime through one of two channels, without a rebuild:
 *
 *   1. A JSON document fetched by the page at startup from
 *      `<assets>/config.json` (see loadSiteConfig). This is the primary path:
 *      change the file, reload, done.
 *   2. The `overlay:configure` postMessage the page already sends to the SW,
 *      carrying the same object. Used when the page obtained the config from a
 *      query string or an inline script.
 *
 * The defaults below intentionally contain NO intranet IP addresses: in route-
 * table mode the browser only names the logical public host it is standing in
 * for, and the intranet agent resolves the real target from its own
 * routes.yaml. That keeps the front-end bundle free of site-specific data.
 */

/** An intranet endpoint the overlay can reach. */
export interface OverlayTarget {
  /** IPv4 literal, or a logical host the agent resolves (see logicalHost). */
  ipv4: string;
  port: number;
}

/**
 * One routing rule. Mirrors the agent's routes.yaml.
 *
 *   host   — the whole public host goes to one target
 *   prefix — a path prefix on a public host goes to one target
 */
export type RouteRule =
  | { kind: "host"; host: string; target: OverlayTarget }
  | { kind: "prefix"; host: string; prefix: string; target: OverlayTarget; publicHost?: string };

/**
 * Per-site behaviour knobs. Optional: a deployment that only cares about route
 * rules can omit them and inherit the defaults below.
 */
export interface SiteProfile {
  /**
   * Path prefixes intercepted by the Service Worker. Defaults to ["/api/"].
   * Static assets stay on nginx (faster, cacheable). 
   */
  apiPrefixes: string[];
  /**
   * Paths that must ALWAYS consult the origin (never tunnelled). Use for auth
   * endpoints that report login via a 200 body instead of 401, or that need the
   * browser's httpOnly cookie — the SW cannot read that cookie off a Request.
   */
  neverTunnel: string[];
  /**
   * Path used to verify a tunnel actually carries traffic after connect.
   * Any HTTP status proves the round-trip (see probeTunnel), so a 401/404 is
   * acceptable — pick something cheap rather than a slow business endpoint
   * (a slow endpoint would make a healthy tunnel look dead).
   *
   * MUST fall under one of apiPrefixes. Otherwise the Service Worker never
   * intercepts it, the request always reaches nginx, and every connect attempt
   * wrongly reports "tunnel down". The default satisfies this by sitting under
   * the default prefix.
   */
  probePath: string;
}

/**
 * Signaling / ICE defaults. Optional; omit to inherit the built-in values.
 * `stun` is a comma-separated list of STUN URLs ("" disables STUN, host
 * candidates only — fine on a LAN).
 */
export interface SignalingProfile {
  /** Signaling room to join. */
  room: string;
  /** Comma-separated STUN URLs. Defaults to a public STUN server. */
  stun: string;
}

/** The complete overlay configuration. */
export interface SiteConfig {
  routes: RouteRule[];
  site: SiteProfile;
  signaling: SignalingProfile;
}

export const DEFAULT_SIGNALING_PROFILE: SignalingProfile = {
  room: "lan",
  stun: "stun:stun.chat.bilibili.com:3478",
};

/**
 * Defaults for a deployment that has not supplied a config. The sense host is
 * listed only as a logical marker; with no IP it means "ask the agent", which
 * resolves sense.jshuaxin.net through its routes.yaml.
 */
export const DEFAULT_SITE_PROFILE: SiteProfile = {
  apiPrefixes: ["/api/"],
  neverTunnel: ["/api/auth/session"],
  probePath: "/api/",
};

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  routes: [],
  site: DEFAULT_SITE_PROFILE,
  signaling: DEFAULT_SIGNALING_PROFILE,
};

/**
 * Merge a partial/override config over the defaults. Lists are replaced, not
 * concatenated: a deployment that sets apiPrefixes means exactly those.
 */
export function mergeSiteConfig(base: SiteConfig, override: Partial<SiteConfig> | undefined): SiteConfig {
  if (!override) return base;
  return {
    routes: override.routes ?? base.routes,
    site: { ...base.site, ...(override.site ?? {}) },
    signaling: { ...base.signaling, ...(override.signaling ?? {}) },
  };
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIPv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

export function parseTarget(ipv4: string, port: number): OverlayTarget {
  if (!isValidIPv4(ipv4)) throw new Error(`invalid IPv4: ${JSON.stringify(ipv4)}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${JSON.stringify(port)}`);
  }
  return { ipv4, port };
}

/** "10.1.1.230:9011" shorthand for config convenience. */
export function parseAuthority(authority: string, defaultPort = 80): OverlayTarget {
  const colon = authority.lastIndexOf(":");
  const ipv4 = colon === -1 ? authority : authority.slice(0, colon);
  const portText = colon === -1 ? "" : authority.slice(colon + 1);
  const port = portText === "" ? defaultPort : Number(portText);
  return parseTarget(ipv4, port);
}

export function targetToAuthority(t: OverlayTarget): string {
  return `${t.ipv4}:${t.port}`;
}

/**
 * Validate and normalise a raw config object (e.g. parsed from JSON). Throws on
 * structural problems so misconfiguration surfaces at load, not mid-request.
 */
export function normalizeSiteConfig(raw: unknown): SiteConfig {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return DEFAULT_SITE_CONFIG;

  const routes = Array.isArray(obj.routes) ? (obj.routes as RouteRule[]) : DEFAULT_SITE_CONFIG.routes;
  const siteRaw = (obj.site ?? {}) as Partial<SiteProfile>;
  const signalingRaw = (obj.signaling ?? {}) as Partial<SignalingProfile>;

  const site: SiteProfile = {
    apiPrefixes:
      Array.isArray(siteRaw.apiPrefixes) && siteRaw.apiPrefixes.length > 0
        ? siteRaw.apiPrefixes.map(String)
        : DEFAULT_SITE_PROFILE.apiPrefixes,
    neverTunnel: Array.isArray(siteRaw.neverTunnel)
      ? siteRaw.neverTunnel.map(String)
      : DEFAULT_SITE_PROFILE.neverTunnel,
    probePath: typeof siteRaw.probePath === "string" && siteRaw.probePath !== ""
      ? siteRaw.probePath
      : DEFAULT_SITE_PROFILE.probePath,
  };

  const signaling: SignalingProfile = {
    room: typeof signalingRaw.room === "string" && signalingRaw.room !== ""
      ? signalingRaw.room
      : DEFAULT_SIGNALING_PROFILE.room,
    stun: typeof signalingRaw.stun === "string" ? signalingRaw.stun : DEFAULT_SIGNALING_PROFILE.stun,
  };

  return { routes, site, signaling };
}
