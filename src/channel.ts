/**
 * One request = one DataChannel.
 *
 * This is deliberately simpler than a multiplexed stream layer:
 *
 *   - a fresh DataChannel per HTTP request gives isolation for free,
 *     so no stream ids, no frame headers, no reassembly bookkeeping;
 *   - DataChannel is already ordered and reliable, so no TCP emulation;
 *   - the peer closes the channel once the response is fully sent.
 *
 * End-of-message convention (matching the agent):
 *   client sends 16KiB fragments, then an EMPTY message
 *   agent  sends 16KiB fragments, then an EMPTY message
 */

/** 16 KiB - 1, comfortably under the SCTP message limit. */
export const MTU = 16 * 1024 - 1;

export interface DataChannelLike {
  readyState: string;
  bufferedAmount: number;
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

/** Split a payload into MTU-sized fragments. */
export function fragment(data: Uint8Array, mtu = MTU): ArrayBuffer[] {
  if (mtu <= 0) throw new Error("mtu must be positive");
  if (data.byteLength === 0) return [];
  const out: ArrayBuffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += mtu) {
    out.push(data.subarray(offset, Math.min(offset + mtu, data.byteLength)).slice().buffer);
  }
  return out;
}

export interface ChannelSender {
  /** Send the whole payload (fragmented) then the empty end-of-message marker. */
  sendAll(data: Uint8Array): Promise<void>;
  /** Read until the peer sends its empty marker; resolves with the joined bytes. */
  receiveAll(timeoutMs?: number): Promise<Uint8Array>;
  close(): void;
}

/**
 * Event objects stringify to "[object Object]", which hides the real cause.
 * Pull out the useful bits instead.
 */
export function describeError(event: unknown): string {
  const e = event as Record<string, any> | null | undefined;
  const inner = e?.error;
  if (inner instanceof Error) return inner.message;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object" && typeof inner.message === "string") return inner.message;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && typeof e.type === "string") return "event type=" + e.type;
  return String(event);
}

export class ChannelTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(what + " timed out after " + timeoutMs + "ms");
    this.name = "ChannelTimeoutError";
  }
}

/**
 * Wraps a DataChannel with the send/receive conventions above.
 * Backpressure is honoured by waiting on bufferedAmount to drain.
 */
export function createChannelSender(dc: DataChannelLike, maxBuffered = 4 * 1024 * 1024): ChannelSender {
  const chunks: ArrayBuffer[] = [];
  let done = false;
  let failed: Error | null = null;
  let waiter: (() => void) | null = null;

  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };

  dc.binaryType = "arraybuffer";
  dc.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      failed = new Error("peer sent a non-binary message");
      done = true;
      wake();
      return;
    }
    if (event.data.byteLength === 0) {
      done = true;
      wake();
      return;
    }
    chunks.push(event.data);
    wake();
  });

  dc.addEventListener("error", (e) => {
    failed = new Error("data channel error: " + describeError(e));
    done = true;
    wake();
  });

  const waitOpen = (): Promise<void> => {
    if (dc.readyState === "open") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      dc.addEventListener("open", () => resolve());
      dc.addEventListener("close", () => reject(new Error("data channel closed before open")));
    });
  };

  return {
    async sendAll(data: Uint8Array): Promise<void> {
      await waitOpen();
      for (const frame of fragment(data)) {
        let spins = 0;
        while (dc.bufferedAmount > maxBuffered) {
          if (++spins > 5_000) throw new Error("data channel send buffer stalled");
          await new Promise((r) => setTimeout(r, 2));
        }
        dc.send(frame);
      }
      dc.send(new ArrayBuffer(0));
    },

    async receiveAll(timeoutMs = 120_000): Promise<Uint8Array> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (failed) throw failed;
        if (done) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ChannelTimeoutError("receive", timeoutMs);
        await new Promise<void>((resolve) => {
          waiter = resolve;
          setTimeout(resolve, Math.min(remaining, 250));
        });
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(new Uint8Array(c), offset);
        offset += c.byteLength;
      }
      return out;
    },

    close(): void {
      dc.close();
    },
  };
}
