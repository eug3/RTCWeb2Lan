/**
 * In-process stand-in for the overlay (no network, no WebRTC).
 *
 * Parses the serialized request just enough to choose a reply, so the SW path,
 * routing and HTTP framing can be exercised end-to-end in tests.
 */

import { parseResponse } from "./http1.js";
import type { OverlayTransport } from "./transport.js";

const encoder = new TextEncoder();

function buildResponse(status: number, statusText: string, body: string, contentType: string): Uint8Array {
  const bodyBytes = encoder.encode(body);
  const head = encoder.encode(
    "HTTP/1.1 " + status + " " + statusText + "\r\n" +
      "Content-Type: " + contentType + "\r\n" +
      "Content-Length: " + bodyBytes.byteLength + "\r\n\r\n",
  );
  const out = new Uint8Array(head.byteLength + bodyBytes.byteLength);
  out.set(head, 0);
  out.set(bodyBytes, head.byteLength);
  return out;
}

export function createMockTransport(): OverlayTransport {
  return {
    async exchange(authority: string, requestBytes: Uint8Array): Promise<Uint8Array> {
      const text = new TextDecoder("latin1").decode(requestBytes);
      const requestLine = text.split("\r\n")[0] ?? "";
      const path = requestLine.split(" ")[1] ?? "/";

      if (path.includes("/api/")) {
        const body = JSON.stringify({ mock: true, authority, path });
        return buildResponse(200, "OK", body, "application/json");
      }
      return buildResponse(
        200,
        "OK",
        "<!doctype html><meta charset=\"utf-8\"><title>overlay</title>" +
          "<h1>mock overlay page</h1><p>authority=" + authority + "</p><p>path=" + path + "</p>",
        "text/html; charset=utf-8",
      );
    },
  };
}

export { parseResponse };
