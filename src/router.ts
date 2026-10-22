/**
 * URL-preserving routing.
 *
 * Hard requirement: the browser address bar and every URL the page sees must
 * stay EXACTLY as the user typed them (e.g. https://sense.jshuaxin.net/a/b).
 * The overlay target is an implementation detail carried in the routing table,
 * never in the URL.
 *
 * So instead of encoding "which machine" into the path, we resolve it from the
 * request's own host + path prefix. Two kinds of rules:
 *
 *   1. host rule   — whole host goes to one target:      sense.jshuaxin.net -> 10.1.1.230:9011
 *   2. prefix rule — a path prefix on a host goes to a target:
 *                    portal.example.com /grafana/* -> 10.1.1.90:3000
 *
 * Anything unmatched falls through to the real network untouched.
 *
 * Types and target parsing live in config.ts (the single configuration
 * contract); this module only resolves a request against a rule set.
 */

import { targetToAuthority, type OverlayTarget, type RouteRule } from "./config.js";

export type { OverlayTarget, RouteRule } from "./config.js";
export {
  isValidIPv4,
  parseAuthority,
  parseTarget,
  targetToAuthority,
} from "./config.js";

export interface ResolvedRoute {
  target: OverlayTarget;
  /** Host header to send upstream (kept as the public host unless overridden). */
  hostHeader: string;
  /**
   * Logical public host the request stands for. In route-table mode the agent
   * picks the intranet target from THIS value, so a page served from
   * 127.0.0.1 can still ask for the site normally published as
   * sense.jshuaxin.net.
   */
  publicHost: string;
  /** Path + query sent upstream — normally identical to the incoming one. */
  upstreamPath: string;
  authority: string;
}

/**
 * Resolve a request to an overlay target.
 *
 * `hostname` should already be lowercased and stripped of any port. Prefix rules
 * win over host rules when both match (longest prefix first).
 */
function stripPrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

export function resolveRoute(
  hostname: string,
  pathname: string,
  search: string,
  rules: readonly RouteRule[],
): ResolvedRoute | null {
  const host = hostname.toLowerCase();

  let best: { rule: RouteRule; prefixLen: number } | null = null;
  for (const rule of rules) {
    if (rule.host.toLowerCase() !== host) continue;
    if (rule.kind === "host") {
      if (best === null || best.prefixLen < 0) best = { rule, prefixLen: -1 };
      continue;
    }
    const p = stripPrefix(rule.prefix);
    const matches = pathname === p || pathname === p + "/" || pathname.startsWith(p + "/");
    if (!matches) continue;
    if (best === null || p.length > best.prefixLen) best = { rule, prefixLen: p.length };
  }

  if (best === null) return null;
  const rule = best.rule;
  const target = rule.target;

  // How much of the path reaches the intranet depends on the rule kind:
  //
  //   host rule   -> the whole path belongs to the app, keep it verbatim
  //   prefix rule -> the prefix is a browser-side addressing marker, strip it
  //                  (otherwise the app sees "/tunnel/154/api" instead of "/api")
  let upstreamPath: string;
  if (rule.kind === "host") {
    upstreamPath = pathname + search;
  } else {
    const stripped = pathname.slice(stripPrefix(rule.prefix).length);
    upstreamPath = (stripped === "" ? "/" : stripped) + search;
  }

  const publicHost = rule.kind === "host" ? host : (rule.publicHost ?? host);

  return {
    target,
    // Keep the public Host so vhost-based backends and cookies behave normally.
    hostHeader: publicHost,
    publicHost,
    upstreamPath,
    authority: targetToAuthority(target),
  };
}
