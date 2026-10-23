import { describe, expect, it } from "vitest";
import { parseAuthority, resolveRoute, type RouteRule } from "../src/router.js";

const rules: RouteRule[] = [
  { kind: "host", host: "sense.jshuaxin.net", target: { ipv4: "10.1.1.230", port: 9011 } },
  { kind: "prefix", host: "127.0.0.1", prefix: "/tunnel/154", target: { ipv4: "10.1.1.154", port: 80 } },
  { kind: "prefix", host: "portal.example.com", prefix: "/grafana", target: { ipv4: "10.1.1.90", port: 3000 } },
  { kind: "prefix", host: "portal.example.com", prefix: "/grafana/admin", target: { ipv4: "10.1.1.91", port: 3000 } },
];

describe("resolveRoute", () => {
  it("tunnels a whole host and keeps the path byte-identical", () => {
    const r = resolveRoute("sense.jshuaxin.net", "/api/agents/runs", "?page=2", rules)!;
    expect(r.authority).toBe("10.1.1.230:9011");
    expect(r.upstreamPath).toBe("/api/agents/runs?page=2");
    expect(r.hostHeader).toBe("sense.jshuaxin.net");
  });

  it("does not leak the target into the path", () => {
    const r = resolveRoute("sense.jshuaxin.net", "/very/deep/path", "", rules)!;
    expect(r.upstreamPath).toBe("/very/deep/path");
    expect(r.upstreamPath).not.toContain("10.1.1");
  });

  it("matches a path prefix on another host", () => {
    const r = resolveRoute("127.0.0.1", "/tunnel/154/api/ping", "", rules)!;
    expect(r.authority).toBe("10.1.1.154:80");
  });

  // Regression: the prefix is browser-side addressing sugar. Forwarding it
  // verbatim makes the intranet app see "/tunnel/154/api" and answer 404.
  // This was observed end-to-end against a real agent before being fixed.
  it("strips the prefix before forwarding on prefix rules", () => {
    expect(resolveRoute("127.0.0.1", "/tunnel/154/api/ping", "", rules)!.upstreamPath).toBe("/api/ping");
  });

  it("keeps the query string when stripping a prefix", () => {
    expect(resolveRoute("127.0.0.1", "/tunnel/154/a/b", "?x=1&y=2", rules)!.upstreamPath).toBe("/a/b?x=1&y=2");
  });

  it("maps the bare prefix to root", () => {
    expect(resolveRoute("127.0.0.1", "/tunnel/154", "", rules)!.upstreamPath).toBe("/");
    expect(resolveRoute("127.0.0.1", "/tunnel/154/", "", rules)!.upstreamPath).toBe("/");
  });

  it("does NOT strip the path on host rules", () => {
    expect(resolveRoute("sense.jshuaxin.net", "/api/agents/runs", "", rules)!.upstreamPath).toBe("/api/agents/runs");
  });

  it("prefers the longest matching prefix", () => {
    expect(resolveRoute("portal.example.com", "/grafana/admin/x", "", rules)!.authority).toBe("10.1.1.91:3000");
    expect(resolveRoute("portal.example.com", "/grafana/d/y", "", rules)!.authority).toBe("10.1.1.90:3000");
  });

  it("does not match a prefix that only shares a name boundary", () => {
    expect(resolveRoute("127.0.0.1", "/tunnel/1540/x", "", rules)).toBeNull();
    expect(resolveRoute("portal.example.com", "/grafanax", "", rules)).toBeNull();
  });

  it("passes unknown hosts and paths through", () => {
    expect(resolveRoute("example.com", "/", "", rules)).toBeNull();
    expect(resolveRoute("127.0.0.1", "/index.html", "", rules)).toBeNull();
  });

  it("is case-insensitive on host", () => {
    expect(resolveRoute("SENSE.JSHUAXIN.NET", "/x", "", rules)!.authority).toBe("10.1.1.230:9011");
  });
});

describe("parseAuthority", () => {
  it("parses ip and port", () => {
    expect(parseAuthority("10.1.1.230:9011")).toEqual({ ipv4: "10.1.1.230", port: 9011 });
  });
  it("defaults the port", () => {
    expect(parseAuthority("10.1.1.230")).toEqual({ ipv4: "10.1.1.230", port: 80 });
  });
  it("rejects bad input", () => {
    expect(() => parseAuthority("10.1.1.999:80")).toThrow(/invalid IPv4/);
    expect(() => parseAuthority("10.1.1.1:0")).toThrow(/invalid port/);
  });
});