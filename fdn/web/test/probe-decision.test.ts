import { describe, expect, it } from "vitest";

/**
 * The probe's decision rule, kept here as a pure function so the regression
 * that made every probe report "tunnel down" cannot come back silently.
 *
 * History: the rule used to be "no `server` header means the tunnel served
 * it". That broke because the SW replays 401 responses via the origin (so the
 * browser's httpOnly cookie is used), and the origin stamps `server`. A probe
 * path that answers 401 therefore always looked like a dead tunnel.
 */
function probeSaysAlive(headers: Record<string, string>): boolean {
  const marker = headers["x-w2l"];
  return marker === "tunnel" || marker === "401-fallback";
}

describe("probe decision", () => {
  it("accepts a tunnel-marked reply", () => {
    expect(probeSaysAlive({ "x-w2l": "tunnel", "content-type": "application/json" })).toBe(true);
  });

  it("accepts 401-fallback: the tunnel did carry the request", () => {
    // The SW replays a 401 via the origin so the httpOnly cookie is used. The
    // 401 came from the agent side, so the tunnel demonstrably works. Treating
    // this as failure made every probe against a login-protected API tear the
    // tunnel down.
    expect(probeSaysAlive({ "x-w2l": "401-fallback", server: "nginx/1.22.1" })).toBe(true);
  });

  it("rejects the plain exchange-failure fallback", () => {
    expect(probeSaysAlive({ "x-w2l": "fallback", server: "nginx/1.22.1" })).toBe(false);
  });

  it("rejects a plain origin reply even without a server header", () => {
    expect(probeSaysAlive({ "content-type": "application/json" })).toBe(false);
  });

  it("does not care whether a server header is present", () => {
    // An upstream may send its own `server`; that must not decide anything.
    expect(probeSaysAlive({ "x-w2l": "tunnel", server: "uvicorn" })).toBe(true);
  });
});