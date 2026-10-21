/**
 * Set-Cookie relay.
 *
 * A Service Worker cannot apply Set-Cookie to a response it synthesizes: the
 * Fetch spec strips it from any `new Response()` (verified in Chrome), so a
 * login performed over the tunnel would leave the browser without a session
 * cookie — and every request that later falls back to nginx (overlay down,
 * SPA reload, another device) would be unauthenticated.
 *
 * The agent keeps the session in its own cookie jar, which covers the tunnel
 * path. To cover the passthrough path too, the SW forwards raw Set-Cookie
 * strings to the window clients and the holder iframe assigns them via
 * document.cookie. document.cookie cannot create HttpOnly cookies, so that
 * attribute is dropped; the remaining attributes pass through verbatim and the
 * server only ever matches on the name=value pair anyway.
 */

/** Collect all raw Set-Cookie values from parsed response headers. */
export function extractSetCookies(headers: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "set-cookie" && value.includes("=")) out.push(value);
  }
  return out;
}

/**
 * Turn a raw Set-Cookie value into a string assignable via document.cookie.
 * Returns null when the value has no name=value pair.
 */
export function toDocumentCookie(raw: string): string | null {
  const eq = raw.indexOf("=");
  if (eq === -1) return null;
  const parts = raw.split(";").map((p) => p.trim());
  const kept = parts.filter((p) => {
    const attr = (p.split("=")[0] ?? "").toLowerCase();
    // document.cookie rejects an HttpOnly attribute; drop it and keep going.
    return attr !== "httponly";
  });
  const assignable = kept.join("; ");
  return assignable.includes("=") ? assignable : null;
}

/** Apply relayed cookies on the current origin (best effort). */
export function applySetCookies(raws: ReadonlyArray<string>): number {
  let applied = 0;
  for (const raw of raws) {
    const assignable = toDocumentCookie(raw);
    if (assignable === null) continue;
    try {
      document.cookie = assignable;
      applied++;
    } catch {
      // Invalid cookie (e.g. malformed Max-Age) — skip it.
    }
  }
  return applied;
}
