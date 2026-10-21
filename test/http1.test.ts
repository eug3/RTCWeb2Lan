import { describe, expect, it } from "vitest";
import { encodeRequest, parseResponse } from "../src/http1.js";

const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const enc = (s: string) => new TextEncoder().encode(s);

describe("encodeRequest", () => {
  it("synthesises Host and drops hop-by-hop headers", () => {
    const wire = dec(
      encodeRequest(
        {
          method: "GET",
          path: "/api/x?y=1",
          headers: [
            ["Host", "portal.example.com"],
            ["Connection", "keep-alive"],
            ["Accept", "application/json"],
          ],
        },
        "10.1.1.154:8080",
      ),
    );
    expect(wire.startsWith("GET /api/x?y=1 HTTP/1.1\r\n")).toBe(true);
    expect(wire).toContain("Host: 10.1.1.154:8080\r\n");
    expect(wire).toContain("Accept: application/json\r\n");
    expect(wire).not.toContain("portal.example.com");
    expect(wire).toContain("Connection: close\r\n");
  });

  it("adds Content-Length for a body", () => {
    const body = enc('{"a":1}');
    const text = dec(encodeRequest({ method: "POST", path: "/x", headers: [], body }, "10.1.1.1:80"));
    expect(text).toContain("Content-Length: 7\r\n");
    expect(text.endsWith('{"a":1}')).toBe(true);
  });

  it("omits Content-Length for a bodiless GET", () => {
    const text = dec(encodeRequest({ method: "GET", path: "/", headers: [] }, "10.1.1.1:80"));
    expect(text).not.toContain("Content-Length");
  });
});

describe("parseResponse", () => {
  it("parses a Content-Length response", () => {
    const res = parseResponse(enc("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello"));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(dec(res.body)).toBe("hello");
  });

  it("decodes a chunked response", () => {
    const res = parseResponse(
      enc("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"),
    );
    expect(dec(res.body)).toBe("hello world");
  });

  it("does not mistake CRLFCRLF inside a chunk for the header end", () => {
    const body = "ab\r\n\r\ncd";
    const chunk = body.length.toString(16) + "\r\n" + body + "\r\n0\r\n\r\n";
    const res = parseResponse(enc("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + chunk));
    expect(dec(res.body)).toBe(body);
  });

  it("handles 204 with no body", () => {
    const res = parseResponse(enc("HTTP/1.1 204 No Content\r\n\r\n"));
    expect(res.status).toBe(204);
    expect(res.body.byteLength).toBe(0);
  });

  it("rejects a malformed status line", () => {
    expect(() => parseResponse(enc("garbage\r\n\r\n"))).toThrow(/malformed status/);
  });

  it("rejects a response with no header terminator", () => {
    expect(() => parseResponse(enc("HTTP/1.1 200 OK\r\n"))).toThrow(/no header terminator/);
  });
});
