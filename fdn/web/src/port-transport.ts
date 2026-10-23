/**
 * OverlayTransport backed by a MessagePort to the page-side data plane.
 *
 * The SW cannot hold a WASM/WebRTC instance (it is terminated when idle), so the
 * peer connection lives in the page and the SW asks it to perform one exchange
 * per request.
 *
 * Wire protocol:
 *   sw  -> page : { t: "exchange", id, authority, bytes }
 *   page -> sw  : { t: "result", id, bytes } | { t: "error", id, message }
 *   page -> sw  : { t: "ready" }
 */

import type { OverlayTransport } from "./transport.js";

interface Pending {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

/** Hard cap for one exchange when the owning page died silently. */
/**
 * Upper bound on a single exchange on the message port.
 *
 * This is the safety net for a plane whose owner vanished: Chromium does not
 * reliably fire MessagePort#onclose when the page holding the peer connection
 * unloads, so the SW keeps a transport that reports isReady but can never
 * answer. The common trigger is navigating from the connect page to the site:
 * the new page's holder has not attached yet, the SW still believes the old
 * plane is live, and the requests the app fires on load sit here until this
 * timeout expires before falling back to the origin.
 *
 * A healthy exchange is tens of milliseconds, so a few seconds is generous
 * while keeping that first-load stall short. (It was 25s, which is what made
 * the first request after a redirect appear to hang.)
 */
const DEAD_PORT_TIMEOUT_MS = 3_000;

export class PortOverlayTransport implements OverlayTransport {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ready = false;
  private readyWaiter: (() => void) | null = null;
  private closed = false;
  /** Invoked when the page holding the peer connection goes away. */
  onClose: (() => void) | null = null;

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    // MessagePort#onclose is not in every TS DOM lib but works in Chromium;
    // where it is missing, exchanges simply keep timing out (previous behavior).
    type CloseablePort = MessagePort & { onclose: ((this: MessagePort, ev: Event) => void) | null };
    (this.port as CloseablePort).onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.dispose();
      this.onClose?.();
    };
    port.start();
  }

  get isReady(): boolean {
    return !this.closed && this.ready;
  }

  waitReady(timeoutMs?: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    const base = new Promise<void>((resolve) => {
      this.readyWaiter = resolve;
    });
    if (timeoutMs === undefined) return base;
    return Promise.race([
      base,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("data plane did not become ready")), timeoutMs),
      ),
    ]);
  }

  private onMessage(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    if (msg.t === "ready") {
      this.ready = true;
      const w = this.readyWaiter;
      this.readyWaiter = null;
      w?.();
      return;
    }
    const id = msg.id;
    if (typeof id !== "number") return;
    const op = this.pending.get(id);
    if (!op) return;
    this.pending.delete(id);

    if (msg.t === "result" && msg.bytes instanceof ArrayBuffer) {
      op.resolve(new Uint8Array(msg.bytes));
    } else if (msg.t === "error") {
      op.reject(new Error(String(msg.message)));
    } else {
      op.reject(new Error("malformed data plane reply"));
    }
  }

  exchange(authority: string, requestBytes: Uint8Array): Promise<Uint8Array> {
    // Fail fast when the plane cannot possibly answer. Without this, a request
    // that arrives while the holder is still connecting (e.g. immediately
    // after the connect page redirects to the site) sat on the message port
    // until the dead-port timeout fired — measured at ~25s before it finally
    // fell back to the origin.
    if (!this.isReady) {
      return Promise.reject(new Error("data plane not ready"));
    }

    const id = this.nextId++;
    const copy = requestBytes.slice();
    return new Promise<Uint8Array>((resolve, reject) => {
      // A page that died without the port close event firing would otherwise
      // leave every exchange pending forever; reject so callers can react.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("data plane exchange timed out"));
      }, DEAD_PORT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (bytes: Uint8Array) => { clearTimeout(timer); resolve(bytes); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      });
      this.port.postMessage(
        { t: "exchange", id, authority, bytes: copy.buffer },
        [copy.buffer],
      );
    });
  }

  dispose(): void {
    this.closed = true;
    for (const op of this.pending.values()) {
      op.reject(new Error("data plane disposed"));
    }
    this.pending.clear();
  }
}
