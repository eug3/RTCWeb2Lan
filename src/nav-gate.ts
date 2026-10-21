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
export function injectHolderIntoHtml(html: string, holderSrc: string): string | null {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return null;
  const tag =
    `<iframe src="${holderSrc}" style="display:none;width:0;height:0;border:0" ` +
    `aria-hidden="true" tabindex="-1" title="web2lan-holder"></iframe>`;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/** Headers that must not be copied when an HTML body is rewritten. */
export const REWRITTEN_HTML_DROP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
