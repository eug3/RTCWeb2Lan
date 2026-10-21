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
  /**
   * Read until the peer sends its empty marker; resolves with the joined bytes.
   * `firstChunkMs` bounds how long the FIRST fragment may take: a wedged SCTP
   * stream never delivers anything, so waiting the full timeout on it only
   * burns the caller's budget — fail fast instead.
   */
  receiveAll(timeoutMs?: number, firstChunkMs?: number): Promise<Uint8Array>;
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

  const waitOpen = (timeoutMs = 3_000): Promise<void> => {
    if (dc.readyState === "open") return Promise.resolve();
    // A channel that never leaves "connecting" (DCEP ack lost on some pion /
    // Chrome combinations) would hang sendAll forever and wedge the whole
    // serial queue behind it — fail fast so the retry can open a fresh one.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ChannelTimeoutError("channel open", timeoutMs));
      }, timeoutMs);
      const onOpen = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("data channel closed before open")); };
      const cleanup = () => {
        clearTimeout(timer);
        dc.removeEventListener?.("open", onOpen);
        dc.removeEventListener?.("close", onClose);
      };
      dc.addEventListener("open", onOpen);
      dc.addEventListener("close", onClose);
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

    async receiveAll(timeoutMs = 120_000, firstChunkMs?: number): Promise<Uint8Array> {
      const started = Date.now();
      const deadline = started + timeoutMs;
      for (;;) {
        if (failed) throw failed;
        if (done) break;
        if (firstChunkMs !== undefined && chunks.length === 0 && Date.now() - started > firstChunkMs) {
          throw new ChannelTimeoutError("no first chunk within " + firstChunkMs + "ms", firstChunkMs);
        }
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
