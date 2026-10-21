/**
 * HTTP/1.1 wire helpers.
 *
 * Requests are serialized here (origin-form path + synthesized Host); responses
 * arrive whole, because a DataChannel exchange delivers the complete message
 * before the peer signals end-of-message.
 */

export interface HttpRequestFields {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: Uint8Array;
}

const CRLF = "\r\n";

/** Per-hop headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function encodeRequest(req: HttpRequestFields, hostHeader: string): Uint8Array {
  const lines: string[] = [req.method + " " + req.path + " HTTP/1.1"];
  lines.push("Host: " + hostHeader);

  for (const [rawName, rawValue] of req.headers) {
    if (HOP_BY_HOP.has(rawName.toLowerCase())) continue;
    lines.push(rawName + ": " + rawValue);
  }

  const body = req.body ?? new Uint8Array(0);
  const bodiless = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" || req.method === "OPTIONS";
  if (body.byteLength > 0 || !bodiless) {
    lines.push("Content-Length: " + body.byteLength);
  }
  lines.push("Connection: close");
  lines.push("", "");

  const head = new TextEncoder().encode(lines.join(CRLF));
  if (body.byteLength === 0) return head;
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}

export interface ParsedResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

/** Parse a complete serialized HTTP/1.1 response. */
export function parseResponse(bytes: Uint8Array): ParsedResponse {
  const headerEnd = indexOfCrlfCrlf(bytes);
  if (headerEnd === -1) {
    throw new Error("response has no header terminator");
  }

  const headText = new TextDecoder("latin1").decode(bytes.subarray(0, headerEnd));
  const lines = headText.split(CRLF);
  const statusLine = lines.shift() ?? "";
  const m = /^HTTP\/(\d)\.(\d)\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!m) throw new Error("malformed status line: " + JSON.stringify(statusLine));

  const status = Number(m[3]);
  const statusText = m[4] ?? "";

  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error("malformed header line: " + JSON.stringify(line));
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }

  let body = bytes.subarray(headerEnd + 4);
  const lower = new Map(headers.map(([n, v]) => [n.toLowerCase(), v]));

  if (lower.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
  }

  return { status, statusText, headers, body: body.slice() };
}

function decodeChunked(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = indexOfCrlf(data, offset);
    if (lineEnd === -1) throw new Error("truncated chunk header");
    const sizeLine = new TextDecoder("latin1").decode(data.subarray(offset, lineEnd));
    const size = parseInt(sizeLine.split(";")[0]!.trim(), 16);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error("invalid chunk size: " + JSON.stringify(sizeLine));
    }
    offset = lineEnd + 2;
    if (size === 0) {
      let total = 0;
      for (const p of parts) total += p.byteLength;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.byteLength; }
      return out;
    }
    if (data.byteLength < offset + size) throw new Error("truncated chunk body");
    parts.push(data.subarray(offset, offset + size).slice());
    offset += size + 2;
  }
}

function indexOfCrlf(data: Uint8Array, from = 0): number {
  for (let i = from; i + 1 < data.byteLength; i++) {
    if (data[i] === 0x0d && data[i + 1] === 0x0a) return i;
  }
  return -1;
}

function indexOfCrlfCrlf(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.byteLength; i++) {
    if (data[i] === 0x0d && data[i + 1] === 0x0a && data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}
