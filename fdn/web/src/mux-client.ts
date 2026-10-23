/**
 * Client side of the multiplexed tunnel: one DataChannel, many concurrent
 * HTTP exchanges.
 *
 * Replaces the old one-channel-per-request scheme. See mux.ts for why.
 */

import {
  decodeFrame,
  encodeFrame,
  fragment,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  MAX_PAYLOAD,
} from "./mux.js";

export interface DataChannelLike {
  readyState: string;
  bufferedAmount: number;
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

export class ChannelTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(what + " timed out after " + timeoutMs + "ms");
    this.name = "ChannelTimeoutError";
  }
}

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

interface Stream {
  chunks: Uint8Array[];
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A single multiplexed connection. */
export class MuxClient {
  private readonly streams = new Map<number, Stream>();
  private nextStream = 1;
  private closed = false;
  private failure: Error | null = null;

  constructor(
    private readonly dc: DataChannelLike,
    private readonly maxBuffered = 4 * 1024 * 1024,
  ) {
    dc.binaryType = "arraybuffer";
    dc.addEventListener("message", (event) => this.onMessage(event));
    dc.addEventListener("close", () => this.onClose(new Error("data channel closed")));
    dc.addEventListener("error", (e) =>
      this.onClose(new Error("data channel error: " + describeError(e))),
    );
  }

  get isOpen(): boolean {
    return !this.closed && this.dc.readyState === "open";
  }

  get readyState(): string {
    return this.dc.readyState;
  }

  /** Wait until the channel is open; rejects if it closes first. */
  waitOpen(timeoutMs = 10_000): Promise<void> {
    if (this.dc.readyState === "open") return Promise.resolve();
    if (this.closed) return Promise.reject(this.failure ?? new Error("data channel closed"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ChannelTimeoutError("channel open", timeoutMs));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(this.failure ?? new Error("data channel closed before open"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.dc.removeEventListener?.("open", onOpen);
        this.dc.removeEventListener?.("close", onClose);
      };
      this.dc.addEventListener("open", onOpen);
      this.dc.addEventListener("close", onClose);
    });
  }

  /**
   * Run one request/response exchange.
   *
   * Many of these may be in flight at once; replies are matched by stream id.
   */
  async exchange(requestBytes: Uint8Array, timeoutMs = 120_000): Promise<Uint8Array> {
    await this.waitOpen(Math.min(timeoutMs, 10_000));
    if (this.closed) throw this.failure ?? new Error("data channel closed");

    const id = this.nextStream++;
    // Stream ids are 32-bit; wrap and skip ids still in flight.
    if (this.nextStream > 0xffffffff) this.nextStream = 1;
    while (this.streams.has(this.nextStream)) this.nextStream++;

    const done = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(id);
        reject(new ChannelTimeoutError("exchange", timeoutMs));
      }, timeoutMs);
      this.streams.set(id, { chunks: [], resolve, reject, timer });
    });

    try {
      for (const piece of fragment(requestBytes, MAX_PAYLOAD)) {
        await this.drain();
        this.dc.send(encodeFrame(KIND_DATA, id, piece));
      }
      await this.drain();
      this.dc.send(encodeFrame(KIND_END, id, new Uint8Array(0)));
    } catch (error) {
      this.abortStream(id, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    return done;
  }

  private async drain(): Promise<void> {
    let spins = 0;
    while (this.dc.bufferedAmount > this.maxBuffered) {
      if (++spins > 10_000) throw new Error("data channel send buffer stalled");
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data;
    if (!(data instanceof ArrayBuffer)) return;
    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return; // ignore malformed frames rather than killing every stream
    }
    const stream = this.streams.get(frame.stream);
    if (!stream) return; // late frame for a stream we already gave up on

    if (frame.kind === KIND_DATA) {
      if (frame.payload.byteLength > 0) stream.chunks.push(frame.payload.slice());
      return;
    }
    if (frame.kind === KIND_END) {
      this.streams.delete(frame.stream);
      clearTimeout(stream.timer);
      const total = stream.chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of stream.chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      stream.resolve(out);
      return;
    }
    if (frame.kind === KIND_ABORT) {
      this.streams.delete(frame.stream);
      clearTimeout(stream.timer);
      const reason = new TextDecoder().decode(frame.payload) || "peer aborted the stream";
      stream.reject(new Error(reason));
    }
  }

  private abortStream(id: number, error: Error): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    clearTimeout(stream.timer);
    stream.reject(error);
    if (!this.closed) {
      try {
        this.dc.send(
          encodeFrame(KIND_ABORT, id, new TextEncoder().encode(error.message.slice(0, 200))),
        );
      } catch {
        // the channel is already unusable; the close path handles the rest
      }
    }
  }

  private onClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const [id, stream] of this.streams) {
      this.streams.delete(id);
      clearTimeout(stream.timer);
      stream.reject(error);
    }
  }

  close(): void {
    this.onClose(new Error("closed by client"));
    this.dc.close();
  }
}
