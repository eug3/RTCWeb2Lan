/**
 * Page-side config loader.
 *
 * Deployment config lives in `<assets>/config.json`. On startup the page fetches
 * it, normalises it, and pushes it to the Service Worker (overlay:config-json)
 * so the SW knows which hosts/paths to tunnel. The same object is returned to
 * the page so probes (connect verification, holder health check) can read
 * `site.probePath` instead of hard-coding an endpoint.
 *
 * A missing config.json is not an error: we fall back to defaults (which carry
 * no intranet addresses — route-table mode asks the agent to resolve). A query
 * string override (`?config=<json>`) is also accepted for one-off testing.
 */

import {
  DEFAULT_SITE_CONFIG,
  mergeSiteConfig,
  normalizeSiteConfig,
  type SiteConfig,
} from "./config.js";

/** Where the config document is served, relative to the shipped asset dir. */
export function configUrl(assetBase: string): string {
  return assetBase + "/config.json";
}

/**
 * Load the site config. Resolution order:
 *   1. ?config=<urlencoded JSON> query param (testing / bespoke deployments)
 *   2. <assetBase>/config.json
 *   3. built-in defaults
 */
export async function loadSiteConfig(assetBase: string): Promise<SiteConfig> {
  const params = new URLSearchParams(location.search);
  const inline = params.get("config");
  if (inline) {
    try {
      return mergeSiteConfig(DEFAULT_SITE_CONFIG, normalizeSiteConfig(JSON.parse(inline)));
    } catch (error) {
      console.warn("[config] ignoring malformed ?config= override:", error);
    }
  }

  try {
    const res = await fetch(configUrl(assetBase), { cache: "no-store" });
    if (!res.ok) return DEFAULT_SITE_CONFIG;
    const raw = await res.json();
    const normalized = normalizeSiteConfig(raw);
    // Treat an empty routes list as "not configured" so defaults still apply.
    return normalized.routes.length > 0 ? normalized : DEFAULT_SITE_CONFIG;
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}

/** Push a loaded config to the active Service Worker. */
export async function pushConfigToServiceWorker(config: SiteConfig): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: "overlay:config-json", json: config });
}

/** Convenience: load config and push it to the SW in one call. */
export async function loadAndApplyConfig(assetBase: string): Promise<SiteConfig> {
  const config = await loadSiteConfig(assetBase);
  await pushConfigToServiceWorker(config).catch(() => {});
  return config;
}
