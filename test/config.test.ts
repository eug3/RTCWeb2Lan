import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_CONFIG,
  DEFAULT_SITE_PROFILE,
  isValidIPv4,
  mergeSiteConfig,
  normalizeSiteConfig,
  parseAuthority,
  targetToAuthority,
  type SiteConfig,
} from "../src/config.js";

describe("signaling defaults", () => {
  it("ships room/stun defaults", () => {
    expect(DEFAULT_SITE_CONFIG.signaling.room).toBe("lan");
    expect(DEFAULT_SITE_CONFIG.signaling.stun).toContain("stun:");
  });

  it("normalizes signaling and fills gaps", () => {
    expect(normalizeSiteConfig({ signaling: { room: "team" } }).signaling).toEqual({
      room: "team",
      stun: DEFAULT_SITE_CONFIG.signaling.stun,
    });
    expect(normalizeSiteConfig({}).signaling).toEqual(DEFAULT_SITE_CONFIG.signaling);
  });

  it("merges signaling over the base", () => {
    const base: SiteConfig = { ...DEFAULT_SITE_CONFIG, signaling: { room: "a", stun: "s1" } };
    expect(mergeSiteConfig(base, { signaling: { room: "b", stun: "s1" } }).signaling.room).toBe("b");
    expect(mergeSiteConfig(base, { signaling: { room: "b", stun: "s1" } }).signaling.stun).toBe("s1");
  });
});

describe("defaults carry no intranet addresses", () => {
  it("ships an empty route list", () => {
    expect(DEFAULT_SITE_CONFIG.routes).toEqual([]);
  });

  it("ships a generic site profile", () => {
    expect(DEFAULT_SITE_PROFILE.apiPrefixes).toEqual(["/api/"]);
    expect(DEFAULT_SITE_PROFILE.neverTunnel).toEqual(["/api/auth/session"]);
    // Must sit under apiPrefixes so the SW actually intercepts it.
    expect(DEFAULT_SITE_PROFILE.probePath).toBe("/api/");
  });
});

describe("normalizeSiteConfig", () => {
  it("returns defaults for non-objects", () => {
    expect(normalizeSiteConfig(null)).toBe(DEFAULT_SITE_CONFIG);
    expect(normalizeSiteConfig(42)).toBe(DEFAULT_SITE_CONFIG);
    expect(normalizeSiteConfig("x")).toBe(DEFAULT_SITE_CONFIG);
  });

  it("keeps valid routes and site knobs", () => {
    const cfg = normalizeSiteConfig({
      routes: [{ kind: "host", host: "a.example.com", target: { ipv4: "10.0.0.1", port: 80 } }],
      site: { apiPrefixes: ["/v1/"], neverTunnel: ["/auth"], probePath: "/healthz" },
    });
    expect(cfg.routes).toHaveLength(1);
    expect(cfg.site.apiPrefixes).toEqual(["/v1/"]);
    expect(cfg.site.neverTunnel).toEqual(["/auth"]);
    expect(cfg.site.probePath).toBe("/healthz");
  });

  it("fills missing site fields from defaults", () => {
    const cfg = normalizeSiteConfig({ routes: [] });
    expect(cfg.site).toEqual(DEFAULT_SITE_PROFILE);
  });

  it("ignores an empty apiPrefixes list (falls back to default)", () => {
    const cfg = normalizeSiteConfig({ site: { apiPrefixes: [] } });
    expect(cfg.site.apiPrefixes).toEqual(DEFAULT_SITE_PROFILE.apiPrefixes);
  });

  it("ignores a blank probePath", () => {
    const cfg = normalizeSiteConfig({ site: { probePath: "" } });
    expect(cfg.site.probePath).toBe(DEFAULT_SITE_PROFILE.probePath);
  });

  it("tolerates unknown extra keys (e.g. _doc)", () => {
    const cfg = normalizeSiteConfig({ _doc: ["hi"], routes: [] });
    expect(cfg.routes).toEqual([]);
  });
});

describe("mergeSiteConfig", () => {
  const base: SiteConfig = {
    routes: [{ kind: "host", host: "a", target: { ipv4: "10.0.0.1", port: 80 } }],
    site: { apiPrefixes: ["/api/"], neverTunnel: ["/x"], probePath: "/" },
    signaling: { room: "lan", stun: "stun:x:3478" },
  };

  it("returns base when override is undefined", () => {
    expect(mergeSiteConfig(base, undefined)).toBe(base);
  });

  it("replaces routes wholesale, not concatenated", () => {
    const merged = mergeSiteConfig(base, {
      routes: [{ kind: "host", host: "b", target: { ipv4: "10.0.0.2", port: 81 } }],
    });
    expect(merged.routes).toHaveLength(1);
    expect(merged.routes[0]).toMatchObject({ host: "b" });
  });

  it("merges site fields shallowly", () => {
    const merged = mergeSiteConfig(base, { site: { probePath: "/z" } as never });
    expect(merged.site.probePath).toBe("/z");
    // untouched fields survive
    expect(merged.site.apiPrefixes).toEqual(["/api/"]);
    expect(merged.site.neverTunnel).toEqual(["/x"]);
  });
});

describe("target helpers", () => {
  it("validates IPv4", () => {
    expect(isValidIPv4("10.1.1.230")).toBe(true);
    expect(isValidIPv4("999.1.1.1")).toBe(false);
    expect(isValidIPv4("10.1.1.01")).toBe(false);
    expect(isValidIPv4("host")).toBe(false);
  });

  it("parses and reformats authorities", () => {
    expect(parseAuthority("10.1.1.230:9011")).toEqual({ ipv4: "10.1.1.230", port: 9011 });
    expect(parseAuthority("10.1.1.230")).toEqual({ ipv4: "10.1.1.230", port: 80 });
    expect(targetToAuthority({ ipv4: "10.1.1.230", port: 9011 })).toBe("10.1.1.230:9011");
  });

  it("rejects invalid ports", () => {
    expect(() => parseAuthority("10.1.1.1:0")).toThrow();
    expect(() => parseAuthority("10.1.1.1:70000")).toThrow();
  });
});

/**
 * Regression guard: the probe path must be intercepted by the SW. If it
 * falls outside apiPrefixes the request always reaches nginx, probeTunnel
 * sees a `server` header, and EVERY connect attempt reports "tunnel down"
 * even though the tunnel is healthy. (This exact bug shipped once.)
 */
describe("probePath is tunnel-intercepted", () => {
  const covered = (probePath: string, prefixes: string[]) =>
    prefixes.some((p) => probePath === p || probePath.startsWith(p.endsWith("/") ? p : p + "/"));

  it("default probePath falls under the default apiPrefixes", () => {
    expect(covered(DEFAULT_SITE_PROFILE.probePath, DEFAULT_SITE_PROFILE.apiPrefixes)).toBe(true);
  });

  it("a root probe would NOT be covered (documents the trap)", () => {
    expect(covered("/", DEFAULT_SITE_PROFILE.apiPrefixes)).toBe(false);
  });
});
