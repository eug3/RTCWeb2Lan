/**
 * Transport contract between the Service Worker and the overlay.
 *
 * With one DataChannel per HTTP request the natural shape is a single
 * "exchange" call rather than a byte-stream connection: the SW hands over the
 * serialized HTTP request and gets back the serialized HTTP response.
 *
 * This keeps the SW ignorant of whether the peer is a browser, an agent, or the
 * in-process mock.
 */

export interface OverlayTransport {
  /** Send a serialized HTTP/1.1 request, resolve with the serialized response. */
  exchange(authority: string, requestBytes: Uint8Array): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export class OverlayTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(what + " timed out after " + timeoutMs + "ms");
    this.name = "OverlayTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, what: string): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OverlayTimeoutError(what, timeoutMs)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
