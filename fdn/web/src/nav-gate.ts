/**
 * Navigation gate logic for the splash flow.
 *
 * Pure helpers so the "which page should / show" decision is testable without
 * a real Service Worker.
 *
 * Cookies:
 *   w2l_grace  — set right after a successful connect; keeps "/" passing
 *                through while the SPA boots and the holder iframe
 *                re-establishes the data plane (prevents a redirect loop).
 *   w2l_direct — the user chose "enter via reverse proxy"; stop offering the
 *                connecting page for a while.
 */

export interface NavGateInput {
  pathname: string;
  /** overlayEnabled flag from the SW. */
  enabled: boolean;
  /** Cookie header of the navigation request, if any. */
  cookieHeader: string | null;
}

export type NavDecision = "connect-page" | "inject-holder" | "passthrough";

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function decideNavigation(input: NavGateInput): NavDecision {
  // Only the site root gets the splash treatment; deep links and assets load
  // the app directly (the holder still gets injected when the tunnel is up).
  if (input.pathname !== "/") return "passthrough";

  if (input.enabled) return "inject-holder";

  const cookies = parseCookies(input.cookieHeader ?? "");
  if (cookies["w2l_grace"]) return "passthrough";
  if (cookies["w2l_direct"]) return "passthrough";

  return "connect-page";
}

/**
 * Insert the hidden holder iframe just before </body>.
 * Returns null when the document has no </body> (leave it untouched then).
 */
/**
 * The host app (an Angular PWA) registers its own worker on the same scope;
 * each side skipWaiting+claims, so the two registrations fight and /api flips
 * between tunnel and network every few seconds. The overlay owns the SW slot
 * for this origin (an accepted trade-off of the URL-preserving design), so
 * registrations other than the overlay's own script are refused.
 */
const swGuard = (oursSwPath: string): string => `<script>(function(){
  var ours = ${JSON.stringify(oursSwPath)};
  var reg = navigator.serviceWorker && navigator.serviceWorker.register;
  if (!reg) return;
  navigator.serviceWorker.register = function (url, opts) {
    if (new URL(url, location.href).pathname !== ours) {
      return Promise.reject(new Error("web2lan: host service worker disabled while the overlay owns the scope"));
    }
    return reg.call(navigator.serviceWorker, url, opts);
  };
})();</script>`;

export function injectHolderIntoHtml(html: string, holderSrc: string): string | null {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return null;
  // holderSrc is normally absolute (built from the SW's own location); a bare
  // path is enough for the guard, which compares pathnames.
  const swPath = new URL("sw.js", new URL(holderSrc, "https://placeholder.invalid")).pathname;
  const guard = swGuard(swPath);
  const head = html.toLowerCase().indexOf("</head>");
  const guardIdx = head === -1 ? idx : head + "</head>".length;
  const tag =
    `<iframe src="${holderSrc}" style="display:none;width:0;height:0;border:0" ` +
    `aria-hidden="true" tabindex="-1" title="web2lan-holder"></iframe>`;
  return html.slice(0, guardIdx) + guard + html.slice(guardIdx, idx) + tag + html.slice(idx);
}

/** Headers that must not be copied when an HTML body is rewritten. */
export const REWRITTEN_HTML_DROP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
