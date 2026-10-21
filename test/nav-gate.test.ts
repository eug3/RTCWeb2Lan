import { describe, expect, it } from "vitest";
import {
  decideNavigation,
  injectHolderIntoHtml,
  parseCookies,
  REWRITTEN_HTML_DROP_HEADERS,
} from "../src/nav-gate.js";

describe("parseCookies", () => {
  it("parses a normal cookie header", () => {
    expect(parseCookies("w2l_grace=1; other=abc; w2l_direct=1")).toEqual({
      w2l_grace: "1",
      other: "abc",
      w2l_direct: "1",
    });
  });

  it("tolerates empty and malformed input", () => {
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(null as unknown as string)).toEqual({});
    expect(parseCookies(";;=x;;")).toEqual({});
  });
});

describe("decideNavigation", () => {
  const base = { pathname: "/", enabled: false, cookieHeader: null as string | null };

  it("cold visit to / shows the connecting page", () => {
    expect(decideNavigation(base)).toBe("connect-page");
  });

  it("only the exact root path is gated", () => {
    expect(decideNavigation({ ...base, pathname: "/login" })).toBe("passthrough");
    expect(decideNavigation({ ...base, pathname: "/a/" })).toBe("passthrough");
    expect(decideNavigation({ ...base, pathname: "" })).toBe("passthrough");
  });

  it("enabled overlay injects the holder", () => {
    expect(decideNavigation({ ...base, enabled: true })).toBe("inject-holder");
  });

  it("grace cookie passes through right after a connect", () => {
    expect(decideNavigation({ ...base, cookieHeader: "w2l_grace=1" })).toBe("passthrough");
  });

  it("direct cookie passes through when the user chose the proxy", () => {
    expect(decideNavigation({ ...base, cookieHeader: "w2l_direct=1; x=2" })).toBe("passthrough");
  });

  it("inject wins over the direct cookie once the tunnel is up", () => {
    expect(decideNavigation({ ...base, enabled: true, cookieHeader: "w2l_direct=1" })).toBe(
      "inject-holder",
    );
  });
});

describe("injectHolderIntoHtml", () => {
  it("inserts the iframe before </body>", () => {
    const html = "<html><body><h1>hi</h1></body></html>";
    const out = injectHolderIntoHtml(html, "/__lan/holder.html");
    expect(out).toBe(
      '<html><body><h1>hi</h1><iframe src="/__lan/holder.html" style="display:none;width:0;height:0;border:0" aria-hidden="true" tabindex="-1" title="web2lan-holder"></iframe></body></html>',
    );
  });

  it("handles uppercase </BODY>", () => {
    const out = injectHolderIntoHtml("<BODY>x</BODY>", "/h");
    expect(out).toContain("/h");
    expect(out?.toLowerCase().endsWith("</body>")).toBe(true);
  });

  it("keeps the iframe after the last </body> when several exist", () => {
    const html = "<body><script>document.write('</body>')</script></body>";
    const out = injectHolderIntoHtml(html, "/h");
    expect(out?.endsWith("</body>")).toBe(true);
  });

  it("returns null without </body>", () => {
    expect(injectHolderIntoHtml("<p>fragment</p>", "/h")).toBeNull();
  });

  it("escapes nothing fancy in src but stays an attribute", () => {
    const out = injectHolderIntoHtml("<body></body>", '/__lan/holder.html?room=lan&signal=wss%3A%2F%2Fx');
    expect(out).toContain('src="/__lan/holder.html?room=lan&signal=wss%3A%2F%2Fx"');
  });
});

describe("REWRITTEN_HTML_DROP_HEADERS", () => {
  it("covers the length/encoding trio (lowercase; callers lowercase first)", () => {
    expect(REWRITTEN_HTML_DROP_HEADERS.has("content-length")).toBe(true);
    expect(REWRITTEN_HTML_DROP_HEADERS.has("content-encoding")).toBe(true);
    expect(REWRITTEN_HTML_DROP_HEADERS.has("transfer-encoding")).toBe(true);
  });
});
