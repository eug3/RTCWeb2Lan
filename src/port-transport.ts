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

export class PortOverlayTransport implements OverlayTransport {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ready = false;
  private readyWaiter: (() => void) | null = null;

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    port.start();
  }

  get isReady(): boolean {
    return this.ready;
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
    const id = this.nextId++;
    const copy = requestBytes.slice();
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage(
        { t: "exchange", id, authority, bytes: copy.buffer },
        [copy.buffer],
      );
    });
  }

  dispose(): void {
    for (const op of this.pending.values()) {
      op.reject(new Error("data plane disposed"));
    }
    this.pending.clear();
  }
}
